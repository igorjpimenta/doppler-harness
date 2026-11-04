// policy.test.mjs — src/policy.ts: the hook protocol, enforce(), and how
// policy/allowlist.json becomes a host permission map.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compiledPermission, declaredAskPatterns, enforce, mergePermission } from "../../src/policy.ts";
import { rootWith, withRoot } from "../../plugins/opencode/doppler/_harness.js";

const denyHook = `#!/usr/bin/env node
import fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({ decision: "deny", reason: "hook says deny" }));
`;
const silentHook = `#!/usr/bin/env node
import fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf8"));
`;
const crashHook = `#!/usr/bin/env node
throw new Error("hook explodes");
`;
const askHook = `#!/usr/bin/env node
import fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({ decision: "ask", reason: "hook wants a question" }));
`;

test("a deny hook stops the call with its reason", async () => {
  await withRoot({ hooks: { "deny.mjs": denyHook } }, async () => {
    assert.throws(
      () => enforce({ tool: "bash", sessionID: "ses_1" }, { args: { command: "echo hi" } }),
      /hook says deny/
    );
  });
});

test("an ask hook blocks and says why it could not prompt", async () => {
  await withRoot({ hooks: { "ask.mjs": askHook } }, async () => {
    assert.throws(
      () => enforce({ tool: "bash", sessionID: "ses_1" }, { args: {} }),
      /hook wants a question/
    );
  });
});

test("a hook that crashes does not stop the tool call", async () => {
  await withRoot({ hooks: { "crash.mjs": crashHook } }, async () => {
    enforce({ tool: "bash", sessionID: "ses_1" }, { args: {} }); // must not throw
  });
});

test("no hooks is a valid, enforcing-nothing configuration", async () => {
  await withRoot({}, async () => {
    enforce({ tool: "bash", sessionID: "ses_1" }, { args: {} });
  });
});

test("allowlist.json compiles tool allows and ordered bash tiers", async () => {
  const allowlist = JSON.stringify({
    tools: { allow: ["webfetch"] },
    allow: [{ pattern: "git push *" }],
    ask: [{ pattern: "rm -rf *" }],
    deny: [{ pattern: "rm -rf /" }],
  });
  await withRoot({ policy: { "allowlist.json": allowlist } }, async () => {
    const rules = compiledPermission();
    // tools.allow entries land as top-level tool rules, not nested under `tools`
    assert.equal(rules.webfetch, "allow");
    assert.equal(rules.bash["git push *"], "allow");
    assert.equal(rules.bash["rm -rf *"], "ask");
    // deny is written last so it outranks an overlapping ask (last match wins)
    const keys = Object.keys(rules.bash);
    assert.equal(keys.at(-1), "rm -rf /");
    assert.equal(rules.bash["rm -rf /"], "deny");
  });
});

test("a missing or malformed allowlist emits nothing rather than everything", async () => {
  await withRoot({}, async () => {
    assert.equal(compiledPermission(), null);
  });
  await withRoot({ policy: { "allowlist.json": "{ not json" } }, async () => {
    assert.equal(compiledPermission(), null, "malformed is empty, never catch-all");
  });
});

test("no catch-all is ever emitted, so unmatched commands keep the host default", async () => {
  await withRoot({ policy: { "allowlist.json": JSON.stringify({ ask: [{ pattern: "rm -rf *" }] }) } }, async () => {
    const rules = compiledPermission();
    assert.equal(rules.bash["*"], undefined);
  });
});

test("a declared ask pattern compiles, and a malformed declaration does not", async () => {
  await withRoot({ hooks: { "x.mjs": silentHook, "x.ask.json": JSON.stringify({ ask: ["special *"] }) } }, async (home) => {
    assert.deepEqual(declaredAskPatterns(), ["special *"]);
    fs.writeFileSync(path.join(home, "hooks", "bad.ask.json"), "{ not json");
    fs.writeFileSync(path.join(home, "hooks", "bad.mjs"), silentHook);
    assert.deepEqual(declaredAskPatterns(), ["special *"], "malformed adds nothing");
  });
});

test("mergePermission keeps a string rule's meaning and merges an object after it", () => {
  const cfg = { permission: { bash: { "*": "allow" } } };
  mergePermission(cfg, "bash", { "rm -rf *": "ask" });
  assert.deepEqual(cfg.permission.bash, { "*": "allow", "rm -rf *": "ask" });
  mergePermission(cfg, "read", "allow");
  assert.equal(cfg.permission.read, "allow");
});
