// The bridge is the only part of this package that runs inside a session, and
// its contract has two failure modes worth pinning: a hook that says nothing must
// not stop anything, and a hook that says something must. Both are silent when
// they break, so they are asserted here rather than left to a live run.
//
// Run with `node --test test/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DopplerHarness } from "../opencode/doppler.ts";

// A personal root holding exactly the hooks and policy a test names. Only
// `policy/` is pre-created, because that is the one directory the bridge reads
// without needing something in it; hooks/, agents/ and skills/ are created when
// a test puts something there, so "the user has no skills" is expressible.
// Everything the bridge reads resolves from DOPPLER_HOME, so no test can reach
// the real root.
function rootWith({ hooks = {}, policy = {}, skills = {}, mkdir = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-bridge-"));
  fs.mkdirSync(path.join(home, "policy"), { recursive: true });
  for (const d of ["hooks", "agents", "skills", ...mkdir]) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(home, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  for (const [name, body] of Object.entries(hooks)) {
    fs.writeFileSync(path.join(home, "hooks", name), body);
  }
  for (const [name, body] of Object.entries(policy)) {
    fs.writeFileSync(path.join(home, "policy", name), body);
  }
  return home;
}

async function withRoot(spec, fn) {
  const home = rootWith(spec);
  const previous = process.env.DOPPLER_HOME;
  process.env.DOPPLER_HOME = home;
  try {
    return await fn(home, await DopplerHarness({}));
  } finally {
    if (previous === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A hook that decides one way, written the way a user's would be: read the
// payload, print a decision, exit 0.
const hook = (decision, preamble = "") => `#!/usr/bin/env node
import fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
${preamble}
process.stdout.write(JSON.stringify({ decision: ${JSON.stringify(decision)}, reason: "hook says ${decision}" }));
`;

const bashCall = (plugin, command) => plugin["tool.execute.before"](
  { tool: "bash", sessionID: "ses_1", callID: "c1" },
  { args: { command } },
);

test("a deny from a hook blocks the call with its reason", async () => {
  await withRoot({ hooks: { "guard.mjs": hook("deny") } }, async (_, plugin) => {
    await assert.rejects(bashCall(plugin, "rm -rf /"), /hook says deny/);
  });
});

test("an ask blocks too, and says why it could not prompt", async () => {
  // A pre-tool hook can only allow or block. Without this the model is told to
  // re-run a command that will be blocked identically, forever.
  await withRoot({ hooks: { "guard.mjs": hook("ask") } }, async (_, plugin) => {
    await assert.rejects(bashCall(plugin, "git push"), /ASK tier/);
    await assert.rejects(bashCall(plugin, "git push"), /# bypass:/);
  });
});

test("a seeded example hook is documentation, not policy", async () => {
  // It ends in .mjs and sits next to the real hooks, so nothing but an explicit
  // exclusion stops it from enforcing rules the user never chose.
  await withRoot({ hooks: { "hook.example.mjs": hook("deny") } }, async (_, plugin) => {
    await bashCall(plugin, "rm -rf /");
  });
});

test("a hook with no opinion lets the call through", async () => {
  await withRoot({ hooks: { "quiet.mjs": "process.exit(0);\n" } }, async (_, plugin) => {
    await bashCall(plugin, "rm -rf /");
  });
});

test("every hook runs, in sorted order, and the first deny wins", async () => {
  await withRoot({
    hooks: {
      "b-second.mjs": hook("deny", ""),
      "a-first.mjs": hook("ask", ""),
    },
  }, async (_, plugin) => {
    // ask comes first alphabetically, so its message is what surfaces.
    await assert.rejects(bashCall(plugin, "x"), /hook says ask/);
  });
});

test("a hook is told which tool and which args", async () => {
  // One hook per tool is the user's choice, not the bridge's, so the payload has
  // to carry enough for a hook to ignore what is not its business.
  const spy = `import fs from "node:fs";
fs.writeFileSync(process.env.DOPPLER_PROBE, JSON.stringify(JSON.parse(fs.readFileSync(0, "utf8"))));
process.exit(0);
`;
  await withRoot({ hooks: { "spy.mjs": spy } }, async (home, plugin) => {
    const probe = path.join(home, "probe.json");
    process.env.DOPPLER_PROBE = probe;
    try {
      await plugin["tool.execute.before"](
        { tool: "read", sessionID: "ses_9", callID: "c9" },
        { args: { filePath: "/tmp/x" } },
      );
      const seen = JSON.parse(fs.readFileSync(probe, "utf8"));
      assert.equal(seen.tool, "read");
      assert.equal(seen.session_id, "ses_9");
      assert.deepEqual(seen.args, { filePath: "/tmp/x" });
      assert.ok(Array.isArray(seen.source_patterns), "the bridge supplies its CLI verbs");
    } finally {
      delete process.env.DOPPLER_PROBE;
    }
  });
});

test("a hook that crashes does not stop the tool call", async () => {
  // Fail-open is the whole safety property: a broken hook has no opinion, and a
  // non-zero exit is indistinguishable from a hook that is not installed.
  for (const broken of [
    "process.exit(1);\n",
    "throw new Error('boom');\n",
    "process.stdout.write('not json');\n",
    "process.stdout.write(JSON.stringify({ nope: true }));\n",
  ]) {
    await withRoot({ hooks: { "broken.mjs": broken } }, async (_, plugin) => {
      await bashCall(plugin, "rm -rf /");
    });
  }
});

test("one crashing hook does not hide a deny from another", async () => {
  await withRoot({
    hooks: { "a-broken.mjs": "process.exit(1);\n", "b-strict.mjs": hook("deny") },
  }, async (_, plugin) => {
    await assert.rejects(bashCall(plugin, "x"), /hook says deny/);
  });
});

test("no hooks at all is a valid, enforcing-nothing configuration", async () => {
  await withRoot({}, async (_, plugin) => {
    await bashCall(plugin, "rm -rf /");
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.deepEqual(cfg, { agent: {} });
  });
});

test("a session.created event reaches the hooks", async () => {
  const spy = `import fs from "node:fs";
fs.appendFileSync(process.env.DOPPLER_PROBE, JSON.stringify(JSON.parse(fs.readFileSync(0, "utf8"))) + "\\n");
process.exit(0);
`;
  await withRoot({ hooks: { "spy.mjs": spy } }, async (h, plugin) => {
    const probe = path.join(h, "events.log");
    process.env.DOPPLER_PROBE = probe;
    try {
      await plugin.event({ event: { type: "session.created", properties: { info: { id: "ses_7" } } } });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_7" } } });
      const lines = fs.readFileSync(probe, "utf8").trim().split("\n");
      assert.equal(lines.length, 1, "only session.created is a hook event");
      assert.equal(JSON.parse(lines[0]).session_id, "ses_7");
    } finally {
      delete process.env.DOPPLER_PROBE;
    }
  });
});

test("allowlist.json compiles to the host's permission map, verbatim", async () => {
  const allowlist = JSON.stringify({
    allow: [{ pattern: "*DOPPLER_BYPASS_GUARDS=1 grep*" }],
    ask: [{ pattern: "*git push*" }],
    tools: { allow: ["webfetch"] },
  });
  await withRoot({ policy: { "allowlist.json": allowlist } }, async (_, plugin) => {
    const cfg = { permission: {} };
    await plugin.config(cfg);
    assert.deepEqual(cfg.permission, {
      webfetch: "allow",
      bash: { "*git push*": "ask", "*DOPPLER_BYPASS_GUARDS=1 grep*": "allow" },
    });
  });
});

test("compiled rules land after the user's own, so they win", async () => {
  // OpenCode takes the LAST matching pattern. A user who has globally allowed
  // bash must still get these asks, which only holds if doppler appends.
  await withRoot({
    policy: { "allowlist.json": JSON.stringify({ ask: [{ pattern: "*git push*" }] }) },
  }, async (_, plugin) => {
    const cfg = { permission: { bash: { "*": "allow" } } };
    await plugin.config(cfg);
    assert.deepEqual(Object.keys(cfg.permission.bash), ["*", "*git push*"]);
  });
});

test("a string-valued tool rule keeps meaning for every command", async () => {
  await withRoot({
    policy: { "allowlist.json": JSON.stringify({ tools: { allow: ["webfetch"] } }) },
  }, async (_, plugin) => {
    const cfg = { permission: { webfetch: "ask" } };
    await plugin.config(cfg);
    assert.equal(cfg.permission.webfetch, "allow", "the explicit allowlist wins");
  });
});

test("a missing or malformed allowlist emits nothing rather than everything", async () => {
  // Failing open here would be the worst possible direction: an empty file would
  // look like "no restrictions" instead of "no rules loaded".
  for (const spec of [{}, { policy: { "allowlist.json": "{not json" } }]) {
    await withRoot(spec, async (_, plugin) => {
      const cfg = { agent: {} };
      await plugin.config(cfg);
      assert.equal(cfg.permission, undefined);
    });
  }
});

test("no catch-all is ever emitted, so unmatched commands keep the host default", async () => {
  await withRoot({
    policy: { "allowlist.json": JSON.stringify({ ask: [{ pattern: "*git push*" }] }) },
  }, async (_, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.deepEqual(Object.keys(cfg.permission.bash), ["*git push*"]);
  });
});

test("skills are registered only when the root has some", async () => {
  // An empty skills/ would be a dead path in the config, and OpenCode grants an
  // external_directory allowance for every registered root.
  await withRoot({}, async (_, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.equal(cfg.skills, undefined);
  });
  await withRoot({
    skills: { notes: "---\nname: notes\ndescription: d\n---\n" },
  }, async (home, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.deepEqual(cfg.skills.paths, [path.join(home, "skills")]);
  });
});

test("overlay skill roots are added, and bad entries ignored", async () => {
  await withRoot({
    skills: { mine: "---\nname: mine\ndescription: d\n---\n" },
  }, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "overlay.json"), JSON.stringify({
      skillsRoots: [path.join(home, "skills", "mine"), "/nonexistent/root", 42],
    }));
    const cfg = { agent: {} };
    await plugin.config(cfg);
    // The nonexistent root is dropped: registering it would be a dead path.
    assert.deepEqual(cfg.skills.paths, [path.join(home, "skills"), path.join(home, "skills", "mine")]);
  });
});

test("a broken personal root degrades to no doppler, never to a failed startup", async () => {
  // A throw in the config hook is an OpenCode startup error, which would take
  // the user's whole session down over a policy file.
  await withRoot({ policy: { "allowlist.json": JSON.stringify({ tools: "not-an-array" }) } }, async (_, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
  });
});

// --- declared ask patterns --------------------------------------------------
//
// A hook that answers `ask` runs after the harness has settled the call's
// permission, so it cannot open a prompt itself. Declaring the patterns beside
// the hook gets them compiled into config.permission instead, which is the only
// route to a prompt that does not go through the model.

const declares = (body) => ({
  hooks: { "asker.mjs": hook("ask"), "asker.ask.json": body },
});

test("a declared pattern compiles to a permission ask", async () => {
  await withRoot(declares(JSON.stringify({ ask: ["*doppler doctor*"] })), async (_, plugin) => {
    const cfg = {};
    await plugin.config(cfg);
    assert.deepEqual(cfg.permission, { bash: { "*doppler doctor*": "ask" } });
  });
});

test("an allowlist allow does not swallow a declared ask", async () => {
  await withRoot(
    {
      hooks: { "asker.mjs": hook("ask"), "asker.ask.json": JSON.stringify({ ask: ["*doppler doctor*"] }) },
      policy: { "allowlist.json": JSON.stringify({ allow: [{ pattern: "*doppler doctor*" }] }) },
    },
    async (_, plugin) => {
      const cfg = {};
      await plugin.config(cfg);
      assert.equal(cfg.permission.bash["*doppler doctor*"], "ask");
    },
  );
});

test("a hook with no declaration contributes nothing", async () => {
  await withRoot({ hooks: { "plain.mjs": hook("deny") } }, async (_, plugin) => {
    const cfg = {};
    await plugin.config(cfg);
    assert.equal(cfg.permission, undefined);
  });
});

test("a malformed declaration does not become a permission", async () => {
  await withRoot(declares("{ not json"), async (_, plugin) => {
    const cfg = {};
    await plugin.config(cfg);
    assert.equal(cfg.permission, undefined);
  });
});

test("non-string patterns are dropped rather than compiled", async () => {
  await withRoot(declares(JSON.stringify({ ask: ["*ok*", 7, null] })), async (_, plugin) => {
    const cfg = {};
    await plugin.config(cfg);
    assert.deepEqual(cfg.permission.bash, { "*ok*": "ask" });
  });
});

test("an example hook's declaration is not read", async () => {
  await withRoot(
    {
      hooks: {
        "x.example.mjs": hook("ask"),
        "x.example.ask.json": JSON.stringify({ ask: ["*never*"] }),
      },
    },
    async (_, plugin) => {
      const cfg = {};
      await plugin.config(cfg);
      assert.equal(cfg.permission, undefined);
    },
  );
});
