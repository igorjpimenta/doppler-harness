#!/usr/bin/env node
// Opt-in live check: the reload idle gate, against a real OpenCode with a real
// turn. `npm test` cannot hold this property, because holding it means a policy
// edit arriving *while a turn is running* — which needs a model call, a race,
// and a session. The unit tests assert the state machine's shape; this asserts
// that a running turn is not killed and the edit is not lost.
//
// It starts its own server against a throwaway personal root. Pointing it at a
// real root would rewrite the policy you are actually enforcing, mid-test.
//
//   node scripts/live-idle-gate.mjs
//   DOPPLER_LIVE_MODEL=zai-coding-plan/glm-4.6 node scripts/live-idle-gate.mjs
//   DOPPLER_BRIDGE=/path/to/dist/doppler.js node scripts/live-idle-gate.mjs
//
// Costs one model call, so it can fail for reasons that have nothing to do with
// the gate: an unreachable provider, a plan that does not cover the default
// model. OpenCode retries those for minutes before the turn finally ends, and
// until it ends there is no idle boundary to prove anything against — so those
// are reported as SKIP (exit 77), distinct from a gate that misbehaved (exit 1).
// A check that reports a false failure is worse than no check.
//
// DOPPLER_LIVE_MODEL pins the model as provider/model. Without it the harness
// picks its own default, which on some plans is not one the plan covers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function auth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if ((await fetch(`${base}/global/health`, { headers: auth() })).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`opencode did not come up on ${base}`);
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-live-"));
  const dir = path.join(home, "proj");
  for (const d of ["policy", "hooks", "agents", "skills"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const allowlist = path.join(home, "policy", "allowlist.json");
  fs.writeFileSync(allowlist, JSON.stringify({ ask: [{ pattern: "BEFORE *" }], allow: [], tools: { allow: [] } }));

  const port = 4600 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(
    process.env.OPENCODE_BIN || "opencode",
    ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "WARN"],
    {
      cwd: dir,
      env: {
        ...process.env,
        // Only honoured when set: inheriting a developer's DOPPLER_HOME would
        // point the test at the policy they are actually enforcing.
        DOPPLER_HOME: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));

  const pass = (m) => console.log(`  ok    ${m}`);
  const fail = (m) => {
    console.error(`  FAIL  ${m}`);
    process.exitCode = 1;
  };
  const skip = (m) => {
    console.log(`  SKIP  ${m}`);
    if (process.exitCode !== 1) process.exitCode = 77;
  };
  // The turn can die on a provider the plan does not cover, and OpenCode retries
  // that for minutes. Read from the server's own log rather than inferring from
  // timing, so a skip says why.
  const providerFailed = () => /stream error|session\.error|retry_error/i.test(log);

  try {
    await waitForHealth(base);
    pass(`server up on ${base}`);
    pass(`throwaway root ${home}`);

    const call = async (method, route, body) => {
      const res = await fetch(base + route, {
        method,
        headers: { ...auth(), "content-type": "application/json", "x-opencode-directory": dir },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : null;
    };
    const q = `?directory=${encodeURIComponent(dir)}`;

    const patterns = async () => Object.keys((await call("GET", `/config${q}`)).permission?.bash ?? {});
    // /session/status lists only sessions with work in flight; an entry that
    // disappears is the session going idle, which is the boundary being tested.
    const busy = async (id) => {
      const s = await call("GET", `/session/status${q}`);
      const entry = (s ?? {})[id];
      return typeof entry === "string" ? entry : (entry?.type ?? null);
    };

    const pinned = process.env.DOPPLER_LIVE_MODEL ?? "";
    const [providerID, modelID] = pinned.includes("/") ? pinned.split("/") : [];
    const model = providerID && modelID ? { providerID, modelID } : null;
    if (model) pass(`model pinned to ${pinned}`);

    const session = await call("POST", `/session${q}`, {});
    const id = session.id;

    // Fired, not awaited: the edit has to land while this is in flight.
    const turn = call("POST", `/session/${id}/message${q}`, {
      parts: [{ type: "text", text: "Use the bash tool to run exactly: sleep 6 && echo turn-done" }],
      ...(model ? { model } : {}),
    }).catch((e) => ({ error: String(e.message) }));

    let running = false;
    for (let i = 0; i < 100 && !running; i += 1) {
      await sleep(100);
      running = (await busy(id)) === "busy";
    }
    if (!running) {
      skip("the turn never went busy — nothing to race against");
      return;
    }
    pass("turn is running");

    const fresh = `HELD-${Date.now()}`;
    const t0 = Date.now();
    fs.writeFileSync(allowlist, JSON.stringify({ ask: [{ pattern: fresh }], allow: [], tools: { allow: [] } }));

    let leaked = null;
    for (let i = 0; i < 24; i += 1) {
      await sleep(150);
      if ((await patterns()).includes(fresh)) {
        leaked = Date.now() - t0;
        break;
      }
    }
    if (leaked === null) pass(`held ${Date.now() - t0}ms while the turn ran — the gate holds`);
    else fail(`applied ${leaked}ms into a running turn — a dispose mid-turn kills the turn`);

    await turn;

    const messages = await call("GET", `/session/${id}/message${q}`);
    const said = (messages ?? []).flatMap((m) => m.parts ?? []).map((p) => p.text ?? "").join(" ");
    if (said.includes("turn-done")) pass("the turn survived the pending reload");
    else fail("the turn produced no output — the reload may have killed it");

    // Long, because a turn the provider could not serve sits in a retry loop for
    // minutes before it ends, and until it ends there is nothing to release.
    const t1 = Date.now();
    let released = null;
    for (let i = 0; i < 1800; i += 1) {
      await sleep(100);
      if ((await patterns()).includes(fresh)) {
        released = Date.now() - t1;
        break;
      }
    }
    if (released !== null) {
      pass(`released ${released}ms after the turn ended`);
      return;
    }
    if (providerFailed()) skip("the turn never completed — a provider error kept it retrying");
    else fail(`the turn ended (session now ${await busy(id)}) but the edit was never applied`);
  } catch (e) {
    fail(String(e.message ?? e));
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

await main();