// report.test.mjs — src/report.ts: one logger, stderr always, host log when
// a client is handed in.
import assert from "node:assert/strict";
import test from "node:test";

import { report } from "../../../src/report.ts";

test("report writes to stderr and never throws without a client", () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    report("something happened", "warn");
    report("and again", "error", undefined);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^doppler: something happened$/);
  assert.match(lines[1], /^doppler: and again$/);
});

test("report forwards to the host log when the client offers one", async () => {
  const seen = [];
  const client = { app: { log: async (entry) => seen.push(entry) } };
  const original = console.error;
  console.error = () => {};
  try {
    report("forwarded", "info", client);
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].body, { service: "doppler-harness", level: "info", message: "forwarded" });
});

test("a client whose log rejects does not surface the rejection", async () => {
  const client = { app: { log: async () => { throw new Error("log is down"); } } };
  const original = console.error;
  console.error = () => {};
  try {
    report("still fine", "info", client); // must not throw, synchronously
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = original;
  }
});
