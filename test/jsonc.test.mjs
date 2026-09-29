// The splicer edits the user's OpenCode config in place. Getting it wrong
// corrupts a file the user hand-wrote, comments included, so every branch gets
// a case here: run with `node --test test/`.
import assert from "node:assert/strict";
import test from "node:test";

import { insertElement, removeElements, removeWhere, topLevelValueSpan } from "../bin/jsonc.mjs";

const E = '"file:///pkg/opencode/doppler.js"';
const add = (text) => insertElement(text, topLevelValueSpan(text, "plugin"), "plugin", E);
const drop = (text) => removeElements(text, topLevelValueSpan(text, "plugin"), [E]);
// Both spellings are ours: an install made before the .ts rename leaves a .js
// entry behind, and the reader has to recognise it to clear it.
const isDoppler = (literal) => /\/opencode\/doppler\.[jt]s"?$/.test(literal);
const dropDoppler = (text) => removeWhere(text, topLevelValueSpan(text, "plugin"), isDoppler);

test("finds a top-level value span", () => {
  const text = '{\n  "plugin": ["a"]\n}\n';
  const span = topLevelValueSpan(text, "plugin");
  assert.equal(text.slice(span.start, span.end), '["a"]');
});

test("ignores a key nested at a deeper depth", () => {
  assert.equal(topLevelValueSpan('{\n  "mcp": { "plugin": ["x"] }\n}\n', "plugin"), null);
});

test("is not fooled by brackets or comment markers inside strings", () => {
  const text = '{\n  "note": "[//]", /* } */\n  "plugin": ["a"]\n}\n';
  const span = topLevelValueSpan(text, "plugin");
  assert.equal(text.slice(span.start, span.end), '["a"]');
});

test("creates the key as the last top-level property", () => {
  assert.equal(
    add('{\n  // mine { with a brace\n  "model": "a", // trailing\n  "permission": { "bash": { "*": "ask" } }\n}\n'),
    '{\n  // mine { with a brace\n  "model": "a", // trailing\n  "permission": { "bash": { "*": "ask" } },\n  "plugin": [' + E + ']\n}\n',
  );
});

test("creates the key in an otherwise empty config", () => {
  assert.equal(add("{}"), `{"plugin": [${E}]}`);
  assert.equal(add("{\n}\n"), `{\n  "plugin": [${E}]\n}\n`);
});

test("appends to an empty array and to a multi-line array", () => {
  assert.equal(add('{\n  "plugin": []\n}\n'), `{\n  "plugin": [${E}]\n}\n`);
  assert.equal(
    add('{\n  "plugin": [\n    "a"\n  ]\n}\n'),
    `{\n  "plugin": [\n    "a",\n    ${E}\n  ]\n}\n`,
  );
});

test("appends inline without disturbing spacing", () => {
  assert.equal(add('{ "plugin": ["a"] }'), `{ "plugin": ["a", ${E}] }`);
});

test("does not add a second comma to an array that ends in one", () => {
  // A trailing comma is legal jsonc, so the result stays jsonc too and is
  // checked by structure rather than by JSON.parse.
  const out = add('{\n  "plugin": [\n    "a",\n  ]\n}\n');
  assert.equal(out, `{\n  "plugin": [\n    "a",\n    ${E},\n  ]\n}\n`);
  assert.equal(out.match(/,/g).length, 2);
});

test("output stays parseable when the input was strict JSON", () => {
  for (const input of ["{}", '{ "model": "a" }', '{ "plugin": ["a"] }', '{ "plugin": [] }']) {
    assert.doesNotThrow(() => JSON.parse(add(input)), input);
    assert.doesNotThrow(() => JSON.parse(drop(add(input))), input);
  }
});

test("removes an element and the comma that joined it", () => {
  assert.equal(drop('{\n  "plugin": [\n    ' + E + ',\n    "other"\n  ]\n}\n'),
    '{\n  "plugin": [\n    "other"\n  ]\n}\n');
  assert.equal(drop('{\n  "plugin": [\n    "other",\n    ' + E + '\n  ]\n}\n'),
    '{\n  "plugin": [\n    "other"\n  ]\n}\n');
  assert.equal(drop('{\n  "plugin": [\n    ' + E + '\n  ]\n}\n'),
    '{\n  "plugin": [\n  ]\n}\n');
});

test("removing every doppler entry leaves no dangling comma", () => {
  // Mixed .js and .ts on purpose: an install made before the rename leaves a .js
  // entry behind, and the reader has to recognise both as ours to clear them.
  const text = '{\n  "plugin": [\n    "file:///a/opencode/doppler.js",\n    "mid",\n    "file:///b/opencode/doppler.ts",\n    "keep"\n  ]\n}\n';
  assert.equal(dropDoppler(text), '{\n  "plugin": [\n    "mid",\n    "keep"\n  ]\n}\n');
  assert.deepEqual(JSON.parse(dropDoppler(text)).plugin, ["mid", "keep"]);
});

test("clear and re-register is a round trip", () => {
  const text = '{\n  "plugin": [\n    "keep"\n  ]\n}\n';
  assert.equal(drop(add(text)), text);
  assert.equal(dropDoppler(add(add(text))), text);
});

test("removal is a no-op when there is nothing of ours to remove", () => {
  for (const text of ['{\n  "model": "a"\n}\n', '{\n  "plugin": ["x"]\n}\n', '{\n  "plugin": []\n}\n']) {
    assert.equal(dropDoppler(text), text);
  }
});

test("appends after a trailing line comment without commenting out the entry", () => {
  // A naive ",\n  " lands *inside* the comment and the array loses its comma,
  // so the whole config stops parsing. The comma has to go before the comment.
  const out = add('{\n  "plugin": [\n    "a" // why it is here\n  ]\n}\n');
  assert.equal(out, `{\n  "plugin": [\n    "a", // why it is here\n    ${E}\n  ]\n}\n`);
  // A line comment is legal jsonc, not JSON, so check the array's contents
  // through the span reader instead: the point is that the new entry landed
  // outside the comment and the array still has both elements.
  const span = topLevelValueSpan(out, "plugin");
  assert.equal(out.slice(span.start, span.end).includes(E), true);
  assert.equal(out.slice(span.start, span.end).includes('"a"'), true);
});

test("appends after a trailing block comment", () => {
  // The comma belongs to the element, so it goes directly after the value; the
  // comment keeps trailing it and the new entry lands on the next line.
  const out = add('{\n  "plugin": [\n    "a" /* why */\n  ]\n}\n');
  assert.equal(out, `{\n  "plugin": [\n    "a", /* why */\n    ${E}\n  ]\n}\n`);
  assert.deepEqual(JSON.parse(out.replace(/\/\*.*?\*\//g, "")).plugin, ["a", E.slice(1, -1)]);
});

test("steps over a tuple entry rather than splitting it", () => {
  // `plugin` entries may be `["name", {opts}]`. Appending has to treat that
  // whole pair as one element, or the new entry lands inside its options object.
  const out = add('{\n  "plugin": [\n    ["opencode-bar", { "k": "v" }]\n  ]\n}\n');
  assert.equal(out, `{\n  "plugin": [\n    ["opencode-bar", { "k": "v" }],\n    ${E}\n  ]\n}\n`);
  assert.deepEqual(JSON.parse(out).plugin, [["opencode-bar", { k: "v" }], E.slice(1, -1)]);
});

test("does not mistake a URL in a value for a comment", () => {
  const out = add('{\n  "plugin": [\n    "https://example.com/x" // mine\n  ]\n}\n');
  assert.equal(out, `{\n  "plugin": [\n    "https://example.com/x", // mine\n    ${E}\n  ]\n}\n`);
});

test("matches the array's own indentation style", () => {
  for (const [input, indent] of [
    ['{\n  "plugin": [\n    "a"\n  ]\n}\n', "    "],
    ['{\n    "plugin": [\n        "a"\n    ]\n}\n', "        "],
    ['{\n\t"plugin": [\n\t\t"a"\n\t]\n}\n', "\t\t"],
    ['{\n  "plugin":\n    [\n      "a"\n    ]\n}\n', "      "],
  ]) {
    const out = add(input);
    assert.ok(out.includes(`\n${indent}${E}`), JSON.stringify(out));
    assert.ok(out.includes(`${indent}${E}\n`), JSON.stringify(out));
  }
});
