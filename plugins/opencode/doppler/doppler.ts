// doppler → OpenCode bridge. Engine-owned: read in place, never edited, never
// copied into ~/.config/opencode. The personal root holds everything else —
// the hooks it execs, the policy it compiles — and this package ships none of
// it.
//
// It exists because OpenCode has no declarative hook registration: a plugin is
// the only place a policy can reach the tool loop. So the bridge owns nothing
// but harness vocabulary — tool names, event names, which OpenCode CLI verbs add
// a source — and delegates every decision to the user's hooks.
//
// Must stay dependency-free, and must stay out of node_modules. Bun transpiles
// it wherever it sits, but Node refuses to strip types from a file under
// node_modules, so a copy of this engine that npm owns could not be run by node
// at all. That is why the installer copies it into ~/.doppler/opencode/ rather
// than registering the package's own path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Config, Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  engineDistDir,
  engineLoadedHash,
  engineUnitHash,
  engineUpdateAvailable,
  stageEngineUpdate,
} from "./engine-update.ts";
import { NODE, nodeUsable, paths, globalAgentsMd, hasEntries, overlaySkillRoots } from "../../../src/paths.ts";
import { report } from "../../../src/report.ts";
import { enforce, hookFiles, runHook, compiledPermission, mergePermission } from "../../../src/policy.ts";
import { readAgents } from "../../../src/agents.ts";
import { startRefresh, recordEngineLoad, rootSnapshot } from "./refresh.ts";
import type { Refresh } from "./refresh.ts";
import { setup } from "./setup.ts";

export { setup } from "./setup.ts";

// The build this entry is executing, and the directory it was loaded from.
// Both are per-entry: the mechanism compares them against the package on disk
// and stages a copy when they differ.
const ENGINE_SELF_URL = import.meta.url;
const ENGINE_LOADED_HASH: string | null = engineLoadedHash(ENGINE_SELF_URL);

// LEGACY (V1 hosts only): the object-hook form of the bridge, returning
// config/tool.execute.before/event/dispose for OpenCode 1.x. New behavior
// lands in setup(); this path exists so a v1 host keeps working unchanged.
export const DopplerHarness: Plugin = async (input) => {
  const { client } = input;
  // Self-update before anything else: if the package on disk is newer than this
  // module, execute the copy instead and never start a watcher here — the copy
  // starts its own. A copy that fails to import falls back to this one, so a
  // broken build cannot take down the session it was meant to refresh.
  const fresh = stageEngineUpdate(paths().home, ENGINE_SELF_URL, "doppler.js", ENGINE_LOADED_HASH);
  if (fresh) {
    try {
      const mod = (await import(fresh)) as unknown as { DopplerHarness: Plugin };
      return mod.DopplerHarness(input);
    } catch (err) {
      report(
        `engine update available but the new build failed to load (${String((err as Error)?.message ?? err)}); staying on the running build`,
        "warn",
        client,
      );
    }
  }
  // First thing a running copy reports: the one fact `doctor` cannot otherwise
  // know — which build this process is actually running.
  recordEngineLoad();
  // Fail-open means a broken runtime is indistinguishable from a permissive one
  // at runtime, so say so once, at the only moment the difference is visible.
  if (!nodeUsable()) {
    report(
      `cannot run node (${NODE}), so every policy hook is inert — install ` +
      "Node 18+ on PATH or set DOPPLER_NODE. Nothing is being enforced.",
      "error", client,
    );
  } else if (hookFiles().length === 0) {
    // No hooks is a legitimate state — this package ships no policy, the root
    // supplies it — but it is indistinguishable from a typo, and a silently
    // inert policy engine is the one outcome nobody can see. So say which it is.
    report(
      `no hooks in ${paths().hooks}, so nothing is being enforced. Expected if ` +
      "you have not written any; see the README for the protocol.",
      "warn", client,
    );
  }

  // One watcher per plugin instance, started from the config hook because that is
  // when this instance's snapshot is taken. A reload disposes the instance, which
  // runs `dispose` below, which stops this one — the rebuilt instance starts its
  // own.
  let refresh: Refresh | undefined;

  return {
    config: async (cfg) => {
      // A throw here would be an OpenCode startup failure, so the whole hook is
      // best-effort: a broken personal root degrades to "no doppler", never to
      // "opencode will not boot".
        try {
          // The published Config type for the running harness version has no
          // `skills` field, though the harness reads it — verified by delivery, not
          // by the schema. So this one is cast rather than typed, and the reason is
          // recorded here instead of left as a mystery `as`.
          const host = cfg as Config & { skills?: { paths?: string[] } };
          // A root with nothing in it is a dead path in the config, and OpenCode
          // grants an external_directory allowance per registered root — so an
          // empty one is a cost with no benefit.
          const skills = [paths().skills, ...overlaySkillRoots()].filter(hasEntries);
        if (skills.length) {
          host.skills = host.skills && typeof host.skills === "object" ? host.skills : {};
          const existing = Array.isArray(host.skills.paths) ? host.skills.paths : [];
          host.skills.paths = [...new Set([...existing, ...skills])];
        }

        const permission = compiledPermission();
        if (permission) {
          for (const [tool, rule] of Object.entries(permission)) mergePermission(cfg, tool, rule);
        }

        // A root AGENTS.md is the personal root's standing instructions, and it
        // is registered like the skills above — read in place, deduped against
        // whatever the user already listed. It is a fallback, not an override:
        // the native global path (globalAgentsMd) is the user's own voice, and
        // a root file that applied alongside it would leave two standing
        // instructions with no visible precedence. So when the user has one,
        // the root's stays dormant — the same "the user's own wins" rule as
        // the agents below.
        const agentsMd = path.join(paths().home, "AGENTS.md");
        if (fs.existsSync(agentsMd) && !fs.existsSync(globalAgentsMd())) {
          const listed = Array.isArray(cfg.instructions) ? cfg.instructions : [];
          cfg.instructions = [...new Set([...listed, agentsMd])];
        }

        for (const agent of readAgents()) {
          cfg.agent = cfg.agent && typeof cfg.agent === "object" ? cfg.agent : {};
          if (cfg.agent[agent.name]) continue; // the user's own agent wins
          cfg.agent[agent.name] = { ...agent.config, prompt: agent.prompt };
        }
      } catch {
        // see above
      }
      // Outside the try on purpose: the config injection above is best-effort, but
      // a session that came up degraded is exactly the one whose policy is most
      // likely being edited, so the thing that makes the edit visible must not
      // depend on the edit being well-formed.
      if (!refresh) refresh = startRefresh(input, client, {}, { selfUrl: ENGINE_SELF_URL, loadedHash: ENGINE_LOADED_HASH });
    },

    "tool.execute.before": async (input, output) => {
      // A tool call is proof a turn is running, which is the one thing the reload
      // flush must not do through. Recorded before enforce so a denied call still
      // counts as activity.
      refresh?.activity();
      // Deliberately not wrapped: a deny or ask has to reach the model as a
      // thrown error, which is the only thing that stops the call.
      enforce(input, output);
    },

    event: async ({ event }) => {
      // Session state, not just session.created: the reload flush waits for an
      // idle boundary, and it has to be told where the boundaries are.
      if (event.type === "session.status") {
        const status = (event.properties as { status?: { type?: string } } | undefined)?.status?.type;
        if (status === "idle") refresh?.idle();
        else refresh?.activity();
        return;
      }
      // `session.idle` is the deprecated spelling of the above and still emitted
      // by some sessions; treating it as unknown would wedge the reloader on a
      // turn it can never see finish.
      if (event.type === "session.idle") {
        refresh?.idle();
        return;
      }

      // A session-start hook, if the user wrote one, is a hook like any other
      // and is told what it is for here. It gets the same payload shape, so one
      // hook can serve both roles if it wants.
      if (event.type !== "session.created") return;
      const id = event.properties?.info?.id;
      if (!id) return;
      const payload = { session_id: id, event: "session.created" };
      for (const file of hookFiles()) {
        runHook(path.join(paths().hooks, file), payload);
      }
    },

    dispose: async () => {
      // The instance is being torn down — either because a reload fired, or
      // because the process is ending. Either way the watcher has to stop here: it
      // would otherwise outlive the hooks object it belongs to and, on a reload,
      // race the rebuilt instance's own.
      refresh?.stop();
      refresh = undefined;
    },
  };
};

// The bridge declares its id so the installer can tell it from a plugin the
// user wrote to replace it: OpenCode loads every registered plugin and does not
// dedup by id, so "doppler is the secondary option" is doppler's own check, not
// the harness's. A same-id plugin already registered means the user's is the
// primary and this bridge stays dormant. The id is a stable contract — the
// installer matches on it, and a user replacing doppler names theirs the same.

// setup() first: it is the entry. server() is the legacy V1 path, kept until
// the v1 support window closes — a legacy host never calls setup, a current
// host never calls server.
export default { id: "doppler", setup, server: DopplerHarness };

// The refresh internals, for the test suite. What counts as a change worth
// reloading for is a claim the bridge makes on the user's behalf — an edit that
// silently costs a session restart, or one that silently fails to — and the only
// place that can be asserted is from inside the module. Not part of the plugin
// contract: OpenCode reads the default export and nothing else.
export const internals = {
  rootSnapshot,
  startRefresh,
  engineUnitHash,
  engineLoadedHash,
  engineDistDir,
  engineUpdateAvailable,
  stageEngineUpdate,
};
