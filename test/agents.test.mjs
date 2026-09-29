// The bridge's frontmatter parser decides what an agent is allowed to do, and
// its failure mode is silent: a restriction it does not understand is dropped,
// and the agent keeps every tool. So the parsing is pinned here rather than
// left to the live config.
//
// Run with `node --test test/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DopplerHarness } from "../opencode/doppler.js";

async function inject(home, files) {
  const previous = process.env.DOPPLER_HOME;
  process.env.DOPPLER_HOME = home;
  const dirs = { agents: path.join(home, "agents"), hooks: path.join(home, "hooks"), policy: path.join(home, "policy") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dirs.agents, name), body);
  }
  try {
    const plugin = await DopplerHarness({});
    const cfg = { agent: {} };
    await plugin.config(cfg);
    return Object.fromEntries(Object.entries(cfg.agent).filter(([k]) => k.startsWith("doppler-")));
  } finally {
    if (previous === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const tmp = (name) => path.join(os.tmpdir(), `doppler-agents-${name}-${process.pid}`);
const denied = (agent) => Object.entries(agent?.permission ?? {})
  .filter(([, action]) => action === "deny")
  .map(([tool]) => tool)
  .sort();

test("a tools list denies everything it does not name", async () => {
  const [name, agent] = Object.entries(await inject(tmp("list"), {
    "auditor.md": "---\ndescription: d\ntools: [Read, Bash, Grep, Glob]\n---\n\nBody.",
  }))[0];

  assert.equal(name, "doppler-auditor");
  for (const tool of ["edit", "write", "task", "webfetch"]) {
    assert.ok(denied(agent).includes(tool), `${tool} should be denied`);
  }
  for (const tool of ["bash", "read", "grep", "glob"]) {
    assert.ok(!denied(agent).includes(tool), `${tool} was named, so it must stay available`);
  }
});

test("the tools field is never forwarded", async () => {
  // A list is not the object shape AgentConfig validates, so forwarding it
  // would be dropped at startup and fail open.
  const [, agent] = Object.entries(await inject(tmp("noforward"), {
    "a.md": "---\ndescription: d\ntools: [Read]\n---\n\nBody.",
  }))[0];
  assert.equal(agent.tools, undefined);
});

test("tool names are matched case-insensitively and through aliases", async () => {
  const [, agent] = Object.entries(await inject(tmp("case"), {
    "a.md": "---\ndescription: d\ntools: [read, Bash, multiEdit]\n---\n\nBody.",
  }))[0];
  // multiEdit is a Claude-style alias for edit, so naming it grants edit rather
  // than silently leaving a deny in place that the author did not ask for.
  for (const tool of ["read", "bash", "edit"]) {
    assert.ok(!denied(agent).includes(tool), `${tool} was named, so it must stay available`);
  }
  assert.ok(denied(agent).includes("write"), "write was not named, so it stays denied");
});

test("an explicit permission block wins over the derived denies", async () => {
  const [, agent] = Object.entries(await inject(tmp("explicit"), {
    "a.md": "---\ndescription: d\ntools: [Read, WebFetch]\npermission:\n  edit: deny\n---\n\nBody.",
  }))[0];
  assert.ok(denied(agent).includes("edit"));
  assert.ok(denied(agent).includes("write"), "write is still unnamed, so still denied");
  assert.ok(!denied(agent).includes("webfetch"), "webfetch was named and not overridden");
});

test("an agent with no tools key gets no invented restriction", async () => {
  const [, agent] = Object.entries(await inject(tmp("notools"), {
    "a.md": "---\ndescription: d\nmode: subagent\n---\n\nBody.",
  }))[0];
  assert.deepEqual(denied(agent), []);
  assert.equal(agent.mode, "subagent");
});

test("a malformed tools value is ignored rather than locking the agent down", async () => {
  // Failing closed here would silently break a working agent, which is the one
  // outcome the owner cannot see.
  const [, agent] = Object.entries(await inject(tmp("malformed"), {
    "a.md": "---\ndescription: d\ntools: []\n---\n\nBody.",
  }))[0];
  assert.deepEqual(denied(agent), []);
});

test("an agent with no body is skipped", async () => {
  const agents = await inject(tmp("nobody"), {
    "a.md": "---\ndescription: d\ntools: [Read]\n---\n\n   \n",
  });
  assert.deepEqual(Object.keys(agents), []);
});

test("one malformed agent does not cost the user the others", async () => {
  const agents = await inject(tmp("partial"), {
    "good.md": "---\ndescription: d\ntools: [Read]\n---\n\nBody.",
    "bad.md": "no frontmatter at all",
  });
  assert.deepEqual(Object.keys(agents), ["doppler-good"]);
});

test("a user's own agent is never shadowed", async () => {
  const previous = process.env.DOPPLER_HOME;
  const home = tmp("collide");
  process.env.DOPPLER_HOME = home;
  fs.mkdirSync(path.join(home, "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", "a.md"), "---\ndescription: from the root\n---\n\nRoot body.");
  try {
    const plugin = await DopplerHarness({});
    const cfg = { agent: { "doppler-a": { description: "mine" } } };
    await plugin.config(cfg);
    assert.equal(cfg.agent["doppler-a"].description, "mine");
  } finally {
    if (previous === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
