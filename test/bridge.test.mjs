// The bridge is the only part of this package that runs inside a session, and
// its contract has two failure modes worth pinning: a hook that says nothing must
// not stop anything, and a hook that says something must. Both are silent when
// they break, so they are asserted here rather than left to a live run.
//
// Run with `node --test test/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DopplerHarness, internals } from "../opencode/doppler.ts";

// A personal root holding exactly the hooks and policy a test names. Only
// `policy/` is pre-created, because that is the one directory the bridge reads
// without needing something in it; hooks/, agents/ and skills/ are created when
// a test puts something there, so "the user has no skills" is expressible.
// Everything the bridge reads resolves from DOPPLER_HOME, so no test can reach
// the real root. The process home is always faked too — empty unless
// `globalAgentsMd` gives content for a fake ~/.config/opencode/AGENTS.md —
// because the bridge reads that path from os.homedir() (which honors $HOME on
// POSIX), and on a machine that has real global instructions every
// registration assertion would otherwise depend on the developer's own setup.
function rootWith({ hooks = {}, policy = {}, skills = {}, mkdir = [], globalAgentsMd = null } = {}) {
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
  const fakeProcessHome = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-userhome-"));
  if (globalAgentsMd !== null) {
    fs.mkdirSync(path.join(fakeProcessHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(fakeProcessHome, ".config", "opencode", "AGENTS.md"), globalAgentsMd);
  }
  return { home, fakeProcessHome };
}

async function withRoot(spec, fn) {
  const { home, fakeProcessHome } = rootWith(spec);
  const previousDoppler = process.env.DOPPLER_HOME;
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.DOPPLER_HOME = home;
  process.env.HOME = fakeProcessHome;
  // The bridge resolves the global instructions path the way OpenCode does —
  // XDG_CONFIG_HOME first — so it must point at the fake home's .config too,
  // or a developer's real XDG setting would decide the assertions.
  process.env.XDG_CONFIG_HOME = path.join(fakeProcessHome, ".config");
  try {
    return await fn(home, await DopplerHarness({}));
  } finally {
    if (previousDoppler === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = previousDoppler;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeProcessHome, { recursive: true, force: true });
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

test("a root AGENTS.md is registered as instructions only when it exists", async () => {
  // No file, no registration: an instruction path that does not resolve is a
  // dead entry in every session's config, the same cost as an empty skills/.
  await withRoot({}, async (_, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.equal(cfg.instructions, undefined);
  });
  await withRoot({}, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# standing instructions\n");
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.deepEqual(cfg.instructions, [path.join(home, "AGENTS.md")]);
  });
});

test("the user's own global AGENTS.md outranks the root's", async () => {
  // Two standing instructions with no visible precedence is worse than one
  // dormant file, so the root's is not registered while the user's exists.
  await withRoot({
    globalAgentsMd: "# the user's own\n",
  }, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# the root's\n");
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.equal(cfg.instructions, undefined);
  });
  // And the user's global alone registers nothing — OpenCode reads it
  // natively, so the bridge has nothing to add.
  await withRoot({
    globalAgentsMd: "# the user's own\n",
  }, async (_, plugin) => {
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.equal(cfg.instructions, undefined);
  });
});

test("the global instructions path follows XDG_CONFIG_HOME when set", async () => {
  // OpenCode reads its global config from $XDG_CONFIG_HOME/opencode when the
  // variable is set. A suppression check pinned to ~/.config would read a file
  // OpenCode is not reading, so the bridge must follow the same resolution:
  // a user global in the XDG dir silences the root's, one in ~/.config alone
  // does not.
  await withRoot({
    globalAgentsMd: "# the user's own, via XDG\n",
  }, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# the root's\n");
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.equal(cfg.instructions, undefined);
  });
  // The XDG dir is where the check looks, so a file at the legacy ~/.config
  // path with XDG set is not the user's global as far as OpenCode is concerned
  // — the root's registers.
  await withRoot({}, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# the root's\n");
    const cfg = { agent: {} };
    await plugin.config(cfg);
    assert.deepEqual(cfg.instructions, [path.join(home, "AGENTS.md")]);
  });
});

test("a root AGENTS.md already listed by the user is not registered twice", async () => {
  await withRoot({}, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# standing instructions\n");
    const cfg = { agent: {}, instructions: [path.join(home, "AGENTS.md")] };
    await plugin.config(cfg);
    assert.deepEqual(cfg.instructions, [path.join(home, "AGENTS.md")]);
  });
  // Entries the user listed besides the root AGENTS.md survive untouched.
  await withRoot({}, async (home, plugin) => {
    fs.writeFileSync(path.join(home, "AGENTS.md"), "# standing instructions\n");
    const cfg = { agent: {}, instructions: ["docs/style.md"] };
    await plugin.config(cfg);
    assert.deepEqual(cfg.instructions, ["docs/style.md", path.join(home, "AGENTS.md")]);
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

// --- live refresh ------------------------------------------------------------
//
// OpenCode reads everything the config hook delivers once per instance and
// snapshots it, so an edit to a policy, an agent or a skill is invisible to a
// running session until the instance is rebuilt. The bridge watches for exactly
// that and asks for the rebuild. Three things about it are silent when they
// break, so they are pinned here: which edits count (an edit that is missed
// leaves a policy reading as applied and not being), which do not (an edit that
// counts costs the user a session restart for nothing), and that a turn in
// flight is never interrupted (a dispose mid-turn kills the turn).

// A stand-in for the harness's own server, recording the rebuild requests the
// bridge makes. Any URL would do for the reachability tests; this one also lets a
// request be refused, which is the case that must be reported rather than retried
// forever.
async function sink({ reachable = true } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    res.writeHead(reachable ? 200 : 503, { "content-type": "application/json" });
    res.end("true");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const reported = (lines) => lines.filter((l) => l.includes("could not reach OpenCode to reload")).length;

// The backstop is parked at 10s everywhere below, so anything asserted to
// happen faster than that can only have been the watcher.
const FAST = { backstopMs: 10_000, debounceMs: 15, quietMs: 15, graceMs: 0 };

// Every timing below is a real race between a filesystem event, a debounce and a
// timer, so nothing here waits a fixed span and hopes. It waits for the outcome
// and fails on a deadline, which is what a flaky assertion about latency always
// wanted to say.
//
// The default deadline is generous because these run concurrently — forty of
// them, each with watchers, sockets and spawned hooks — and the machine being
// busy is not a property of the design. Every assertion that actually has an
// opinion about time passes its own tighter bound.
async function waitFor(what, predicate, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
}

// Assert something does NOT happen, which needs the deadline rather than a
// guess at how long "not yet" is.
const quiet = (ms) => new Promise((r) => setTimeout(r, ms));

// A burst like an editor's, and the shape that matters: write-then-rename, so
// the file the watcher was told about is replaced rather than modified.
function atomicSaves(target, body, times = 40) {
  for (let i = 0; i < times; i += 1) {
    fs.writeFileSync(`${target}.tmp`, body(i));
    fs.renameSync(`${target}.tmp`, target);
  }
}

test("what counts as a change is the config snapshot, not the files", async () => {
  // The one that does not count is the important one. Hook bodies are exec'd on
  // every tool call, so they have always been live; reloading for one would make
  // the most common edit in the root the most expensive one.
  await withRoot({ hooks: { "a.mjs": hook("deny") }, policy: { "allowlist.json": "{}" } }, async (home) => {
    const before = internals.rootSnapshot();

    fs.writeFileSync(path.join(home, "hooks", "a.mjs"), hook("deny") + "\n// edited\n");
    assert.equal(internals.rootSnapshot(), before, "a hook body is already live");

    fs.writeFileSync(path.join(home, "hooks", "a.ask.json"), JSON.stringify({ ask: ["*x*"] }));
    assert.notEqual(internals.rootSnapshot(), before, "a declaration compiles into the permission map");

    fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[]}');
    assert.notEqual(internals.rootSnapshot(), before, "permission policy");

    fs.writeFileSync(path.join(home, "agents", "new.md"), "---\n---\nx\n");
    assert.notEqual(internals.rootSnapshot(), before, "agents");

    fs.mkdirSync(path.join(home, "skills", "late"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "late", "SKILL.md"), "---\nname: late\ndescription: d\n---\n");
    assert.notEqual(internals.rootSnapshot(), before, "skills");

    fs.writeFileSync(path.join(home, "AGENTS.md"), "# standing\n");
    assert.notEqual(internals.rootSnapshot(), before, "the instructions registration");

    fs.writeFileSync(path.join(home, "overlay.json"), JSON.stringify({ skillsRoots: [] }));
    assert.notEqual(internals.rootSnapshot(), before, "the overlay roots");
  });
});

test("an overlay skill root is watched even before it exists", async () => {
  // Created after the session started is the case that matters: a root that is
  // only watched once it resolves would never fire for the edit that made it.
  await withRoot({}, async (home) => {
    const root = path.join(home, "skills", "shared");
    fs.writeFileSync(path.join(home, "overlay.json"), JSON.stringify({ skillsRoots: [root] }));
    const before = internals.rootSnapshot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    assert.notEqual(internals.rootSnapshot(), before);
  });
});

test("a policy edit asks the harness to rebuild, and only once", async () => {
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      assert.equal(server.calls.length, 0, "nothing changed yet");
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"x"}]}');
      await waitFor("the reload request", () => server.calls.length > 0);
      assert.equal(server.calls[0].method, "POST");
      assert.match(server.calls[0].url, /\/instance\/dispose\?directory=/);
      // A rebuild that does not tear the watcher down must not become a request
      // every time something pokes it.
      await quiet(200);
      assert.equal(server.calls.length, 1, "the same change is not re-sent");
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a turn in flight is never interrupted by a reload", async () => {
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      refresh.activity();
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"x"}]}');
      await quiet(300);
      assert.equal(server.calls.length, 0, "disposing mid-turn would kill the turn");

      refresh.idle();
      await waitFor("the reload at the idle moment", () => server.calls.length > 0);
      assert.equal(server.calls.length, 1);
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("the manual sentinel reloads even with automatic reloading off", async () => {
  // The escape hatch has to work in the mode that exists to turn automatic
  // reloading off, or it is not an escape hatch.
  const server = await sink();
  const previous = process.env.DOPPLER_RELOAD;
  process.env.DOPPLER_RELOAD = "off";
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"x"}]}');
      await quiet(300);
      assert.equal(server.calls.length, 0, "automatic reloading is off");

      fs.writeFileSync(path.join(home, ".reload"), "1\n");
      await waitFor("the manual request", () => server.calls.length > 0);
      assert.equal(server.calls.length, 1, "`doppler reload` still asks");
    } finally {
      refresh.stop();
      await server.close();
    }
  });
  if (previous === undefined) delete process.env.DOPPLER_RELOAD;
  else process.env.DOPPLER_RELOAD = previous;
});

// Timed against the backstop rather than the wall clock, and given a deadline
// that survives forty concurrent tests: the claim is that the event drove it,
// and the backstop being parked at 10s is what makes that provable. A 4s
// deadline asserted a latency the machine was busy delivering, not a property of
// the design — two runs in six failed here on an otherwise green suite.
test("an edit is picked up from the watcher, not the backstop", { concurrency: false }, async () => {
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"watched"}]}');
      const took = await waitFor("a watcher-driven reload", () => server.calls.length > 0, 8000);
      assert.equal(server.calls.length, 1);
      assert.ok(took < FAST.backstopMs / 2, `took ${took}ms — the backstop cannot have been it`);
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a burst reloads once, for the final state", async () => {
  // A watcher coalesces, so forty saves must cost one reload — and the one that
  // matters is the state that survived, not the first write of the burst.
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      // The last write is the one that reads, which is the whole point: the burst
      // is not forty edits, it is one edit that happened forty times.
      const target = path.join(home, "policy", "allowlist.json");
      atomicSaves(target, (i) => JSON.stringify({ ask: [{ pattern: `v${i}` }] }));
      await waitFor("one reload for the burst", () => server.calls.length > 0);
      await quiet(300);
      assert.equal(server.calls.length, 1, `reloaded ${server.calls.length} times`);
      const reloaded = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.equal(reloaded.ask[0].pattern, "v39", "and it is the final state that survived");
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a change nobody signalled is still caught", async () => {
  // The backstop is the whole reason a watcher is not load-bearing. Bun drops
  // events outright under a fast burst — 60 atomic saves in 9ms produced none —
  // so a design that trusted the event would leave a policy that reads as
  // applied and is not.
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      { backstopMs: 40, debounceMs: 5, quietMs: 5, graceMs: 0 },
    );
    try {
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"unsignalled"}]}');
      await waitFor("the backstop to catch it", () => server.calls.length > 0);
      assert.equal(server.calls.length, 1);
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a reload request does not wait for the backstop once a turn ends", { concurrency: false }, async () => {
  // An edit made mid-turn is held correctly; the idle moment is when it lands,
  // and a half-minute backstop would make that feel like nothing happened.
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      refresh.activity();
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"mid-turn"}]}');
      await quiet(300);
      assert.equal(server.calls.length, 0, "held while the turn runs");
      refresh.idle();
      const took = await waitFor("the release at idle", () => server.calls.length > 0, 8000);
      assert.equal(server.calls.length, 1);
      assert.ok(took < FAST.backstopMs / 2, `took ${took}ms — the backstop cannot have been it`);
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a change held by a window is released when the window closes", async () => {
  // The bug this pins: a change that arrives while the startup grace is still
  // open used to have nothing to wake it, so it sat until the backstop — half a
  // minute of a policy that reads as applied and is not. Found by measuring the
  // real server: an edit landing just after a reload took 30s.
  const server = await sink();
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      { backstopMs: 10_000, debounceMs: 5, quietMs: 5, graceMs: 300 },
    );
    try {
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"held"}]}');
      const t0 = Date.now();
      while (server.calls.length === 0 && Date.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(server.calls.length, 1, "released when the grace closed");
      assert.ok(Date.now() - t0 < 2000, "not left waiting for the backstop");
    } finally {
      refresh.stop();
      await server.close();
    }
  });
});

test("a harness that cannot be reached is named once, not on every poll", async () => {
  // The failure this guards is the one the repo cares about most: a policy that
  // reads as applied while the session still enforces the previous version, with
  // nothing anywhere saying so.
  await withRoot({ policy: { "allowlist.json": "{}" } }, async (home) => {
    const server = await sink({ reachable: false });
    const seen = [];
    const real = console.error;
    console.error = (line) => seen.push(String(line));
    const refresh = internals.startRefresh(
      { directory: home, serverUrl: new URL(server.url) },
      undefined,
      FAST,
    );
    try {
      fs.writeFileSync(path.join(home, "policy", "allowlist.json"), '{"ask":[{"pattern":"x"}]}');
      await waitFor("the failure report", () => reported(seen) === 1);
    } finally {
      refresh.stop();
      console.error = real;
      await server.close();
    }
    assert.equal(reported(seen), 1, "reported once");

    // One attempt, not one per tick: the backoff is what stops a broken reload
    // from becoming a busy loop against a server that is not there.
    assert.equal(server.calls.length, 1, `tried ${server.calls.length} times`);
  });
});

test("the plugin stops polling when the instance is disposed", async () => {
  // A watcher that outlives the hooks object it belongs to would, on a reload,
  // race the rebuilt instance's own watcher.
  await withRoot({}, async (_, plugin) => {
    await plugin.config({});
    await plugin.dispose();
    await plugin.dispose();
  });
});
