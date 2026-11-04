// _harness.js — the shared fixture for the bridge's tests. Not a test file:
// the runner only picks up *.test.mjs, so the leading underscore keeps this
// beside the tests it serves without being one of them (same convention as
// winch's test harness).
//
// A personal root holding exactly what a test names. Only `policy/` is
// pre-created, because that is the one directory the bridge reads without
// needing something in it; hooks/, agents/ and skills/ are created when a
// test puts something there, so "the user has no skills" is expressible.
// Everything the bridge reads resolves from DOPPLER_HOME, so no test can
// reach the real root. The process home is always faked too — empty unless
// `globalAgentsMd` gives content for a fake ~/.config/opencode/AGENTS.md —
// because the bridge reads that path from os.homedir() (which honors $HOME
// on POSIX), and on a machine that has real global instructions every
// registration assertion would otherwise depend on the developer's own setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DopplerHarness } from "./doppler.ts";

export function rootWith({
  hooks = {},
  policy = {},
  skills = {},
  plugins = {},
  mkdir = [],
  globalAgentsMd = null,
  agentsMd = null,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-bridge-"));
  fs.mkdirSync(path.join(home, "policy"), { recursive: true });
  for (const d of ["hooks", "agents", "skills", "plugins", ...mkdir]) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  for (const [name, body] of Object.entries(plugins)) {
    fs.writeFileSync(path.join(home, "plugins", name), body);
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
  if (agentsMd !== null) fs.writeFileSync(path.join(home, "AGENTS.md"), agentsMd);
  const fakeProcessHome = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-userhome-"));
  if (globalAgentsMd !== null) {
    fs.mkdirSync(path.join(fakeProcessHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(fakeProcessHome, ".config", "opencode", "AGENTS.md"), globalAgentsMd);
  }
  return { home, fakeProcessHome };
}

export async function withRoot(spec, fn) {
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
