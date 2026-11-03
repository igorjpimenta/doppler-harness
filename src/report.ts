// report.ts — one logger for the bridge: stderr always, host log when available.
import type { PluginInput } from "@opencode-ai/plugin";


export function report(message: string, level: "debug" | "info" | "warn" | "error", client?: PluginInput["client"]) {
  console.error(`doppler: ${message}`);
  client?.app?.log?.({ body: { service: "doppler-harness", level, message } }).catch?.(() => {});
}

