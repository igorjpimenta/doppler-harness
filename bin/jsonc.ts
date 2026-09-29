// Locate and edit one top-level key in a JSONC config without reparsing the
// file. OpenCode's global config is routinely hand-written with comments, and
// JSON.parse cannot read it while JSON.stringify would silently delete every
// comment the user wrote. So the installer splices text: find the value span of
// one key, edit inside it, leave every other byte alone.

const WS = /\s/;

// A half-open [start, end) range into the text.
type Span = { start: number; end: number };

// Skips a string literal starting at `i` (which must be the opening quote).
// Returns the index just past the closing quote.
function skipString(s: string, i: number): number {
  i += 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i + 1;
    i += 1;
  }
  return i;
}

function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    if (WS.test(s[i])) { i += 1; continue; }
    if (s[i] === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

// Index just past the bracket closing the one at `i`, respecting strings and
// comments. "Just past" keeps every span half-open, so callers never have to
// remember whether the closer is inside it.
//
// Both bracket kinds count toward the depth, not just the kind that opened:
// `["name", {opts}]` is a single array containing an object, and counting only
// `[` would return at the object's `}` and cut the array in half.
function matchBracket(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipString(s, i); continue; }
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) { i = skipTrivia(s, i); continue; }
    if (c === "[" || c === "{") { depth += 1; i += 1; continue; }
    if (c === "]" || c === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

// Past the end of a value starting at `i` (the first non-trivia character
// after a colon).
function skipValue(s: string, i: number, limit: number): number {
  if (s[i] === "[" || s[i] === "{") {
    const end = matchBracket(s, i);
    return end < 0 ? limit : end;
  }
  if (s[i] === '"') return skipString(s, i);
  let end = i;
  while (end < limit && s[end] !== "," && s[end] !== "}") end += 1;
  return end;
}

// Span [start, end) of the value for a top-level `key`, or null. Only depth 1
// counts, and a non-matching key's whole value is skipped — otherwise a "plugin"
// key nested inside another object reads as the top-level one.
export function topLevelValueSpan(text: string, key: string): Span | null {
  if (text[0] !== "{") return null;
  const rootEnd = matchBracket(text, 0);
  if (rootEnd < 0) return null;
  const close = rootEnd - 1;

  let i = 1;
  while (i < close) {
    i = skipTrivia(text, i);
    if (i >= close) break;
    if (text[i] === ",") { i += 1; continue; }
    if (text[i] !== '"') { i += 1; continue; }

    const keyEnd = skipString(text, i);
    const name = JSON.parse(text.slice(i, keyEnd));
    const colon = skipTrivia(text, keyEnd);
    if (text[colon] !== ":") { i = keyEnd; continue; }

    const valueStart = skipTrivia(text, colon + 1);
    if (name === key) {
      const end = skipValue(text, valueStart, close);
      return { start: valueStart, end };
    }
    i = skipValue(text, valueStart, close);
  }
  return null;
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

// Index just past the newline at or after `i`, so a line can be dropped whole.
function pastNewline(s: string, i: number): number {
  while (i < s.length && s[i] !== "\n") i += 1;
  return Math.min(i + 1, s.length);
}

// Index of the first quoted string in s.slice(from, to), or -1.
function firstStringStart(s: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) {
    if (s[i] === '"') return i;
  }
  return -1;
}

// The quoted string elements of the array at `span`, as whole literals.
//
// For reading a value back out of a config that may carry comments. JSON.parse
// cannot be used for that — a commented file is the normal case, not an edge
// case — and a regex cannot be used either, because it cannot tell a `//` inside
// a string from a comment, which a file:// URL is full of. This walks with the
// same string-aware scanner the splicer uses.
export function stringElements(text: string, span: Span | null): string[] {
  if (!span) return [];
  const out = [];
  for (let i = span.start; i < span.end; i += 1) {
    if (text[i] !== '"') continue;
    const end = skipString(text, i);
    out.push(text.slice(i, end));
    i = end - 1;
  }
  return out;
}

// Remove one array element at [at, at+literal.length), together with whichever
// comma separated it from a neighbour. Both directions are handled because
// either may be the one that exists, and a leftover comma would be invalid
// JSON — the failure mode that silently breaks the user's whole config.
function removeOne(text: string, at: number, literal: string): string {
  const e0 = at + literal.length;
  const ls = text.lastIndexOf("\n", at) + 1;
  let nl = e0;
  while (nl < text.length && text[nl] !== "\n") nl += 1;

  const aloneOnLine = isBlank(text.slice(ls, at)) && isBlank(text.slice(e0, nl));

  if (aloneOnLine) {
    // Take the whole line, then the comma that joined it to a neighbour.
    const after = skipTrivia(text, nl);
    if (text[after] === ",") {
      return text.slice(0, ls) + text.slice(pastNewline(text, after));
    }
    let back = ls;
    while (back > 0 && WS.test(text[back - 1])) back -= 1;
    // Keep the newline: it is the one that puts the closing bracket on its own
    // line, and the element's own indent goes with the element.
    if (text[back - 1] === ",") return text.slice(0, back - 1) + text.slice(nl);
    return text.slice(0, ls) + text.slice(pastNewline(text, nl));
  }

  const after = skipTrivia(text, e0);
  if (text[after] === ",") {
    return text.slice(0, ls) + text.slice(pastNewline(text, after));
  }
  let back = at;
  while (back > 0 && WS.test(text[back - 1])) back -= 1;
  if (text[back - 1] === ",") return text.slice(0, back - 1) + text.slice(e0);
  return text.slice(0, at) + text.slice(e0);
}

// Remove every array element equal to one of `literals`. Matching on the exact
// quoted literal is unambiguous — a JSON string only equals itself — so this
// cannot clip a neighbouring entry.
export function removeElements(text: string, span: Span | null, literals: string[]): string {
  return removeWhere(text, span, (literal) => literals.includes(literal));
}

// Same, for elements chosen by predicate on the whole quoted literal. The
// installer uses this to clear entries whose path it no longer knows, e.g.
// after the personal root moved.
export function removeWhere(text: string, span: Span | null, wanted: (literal: string) => boolean): string {
  if (!span) return text;
  let out = text;
  for (;;) {
    let target = null;
    for (let i = span.start; i < span.end; i += 1) {
      if (out[i] !== '"') continue;
      const end = skipString(out, i);
      const literal = out.slice(i, end);
      if (wanted(literal)) { target = { at: i, literal }; break; }
      i = end - 1;
    }
    if (!target) return out;
    const before = out.length;
    out = removeOne(out, target.at, target.literal);
    span = { start: span.start, end: span.end - (before - out.length) };
  }
}

// Append `element` to the array at `span`, or create the key as the last
// top-level property when it is absent. New keys go last rather than first so
// the comma attaches to the property before them and no dangling comma is ever
// written into a file that might be strict JSON.
export function insertElement(text: string, span: Span | null, key: string, element: string): string {
  const entry = `"${key}": [${element}]`;

  if (span) {
    const close = span.end - 1;
    const inner = text.slice(span.start + 1, close);
    if (!inner.trim()) return text.slice(0, span.start + 1) + element + text.slice(close);

    // Append immediately after the array's final element and leave everything
    // that follows in place. That is the only spot that survives a trailing
    // comment: writing at the end of the line would put the new element *inside*
    // a `//` comment and the array would lose its separator and stop parsing.
    // The element is found with the same bracket- and string-aware walk used for
    // the top-level case, so a nested array such as the `["name", {opts}]` tuple
    // form is stepped over whole rather than mistaken for the end of the array.
    const at = lastElementEnd(text, span.start + 1, close);
    if (at < 0) return text.slice(0, close) + element + text.slice(close);
    const multiline = inner.includes("\n");
    // Whitespace sits on both sides of the boundary: `at` is the end of the
    // value, so the gap after it is a comment or the closing bracket, and
    // whatever trails text.slice(0, at) belongs *after* the new comma.
    // Without lifting both, `"a" // why` becomes `"a" ,// why`.
    const before = text.slice(0, at).trimEnd();
    const after = text.slice(at, close);
      const gap = text.slice(0, at).slice(before.length) + /^[\t ]*/.exec(after)![0];
    const { comment, rest } = splitTrailingComment(after.replace(/^[\t ]*/, ""));
    const comma = needsComma(text, at);
    const indent = elementIndentFor(text, span.start, close);
    const sep = comment
      // The comment documents the element it follows, so it stays on that
      // element's line and the new entry goes underneath.
      ? `${comma}${gap}${comment}${rest ? `\n${indent}` : ""}`
      : multiline
        ? `${comma}\n${indent}`
        // Single-line array: reuse the gap if there was one, else a single space.
        : `${comma}${gap || " "}`;
    return before + sep + element + rest + text.slice(close);
  }

  const close = topLevelClose(text);
  const multiline = text.includes("\n");
  const tail = text.slice(0, close);
  if (isBlank(tail.slice(1))) {
    return multiline
      ? `{\n  ${entry}\n${text.slice(close)}`
      : `{${entry}${text.slice(close)}`;
  }
  // After the last value, and immediately after it: a trailing comment must
  // keep the property it documents, and the comma has to sit before that
  // comment or the object loses its separator. lastValueEnd already stops at
  // the end of a trailing comment for exactly this reason.
  const at = lastValueEnd(text, 1, close);
  if (at < 0) return `{${entry}${text.slice(1)}`;
  const lines = tail.slice(0, at).split("\n");
  const indent = /^[\t ]*/.exec(lines[lines.length - 1])?.[0] || "  ";
  const pad = multiline ? `\n${indent}` : " ";
  return `${tail.slice(0, at)},${pad}${entry}${text.slice(at)}`;
}

// A trailing comma is legal in jsonc and users write it; a second one would be
// the malformed file this whole module exists to prevent.
function needsComma(text: string, at: number): string {
  return text.slice(0, at).trimEnd().endsWith(",") ? "" : ",";
}

// A single character of the same whitespace kind as `indent`, i.e. one more
// level. Returning the whole run instead would turn a 4-space indent into 8 and
// visibly reflow the user's file.
function childIndentOf(indent: string): string {
  if (!indent) return "  ";
  return indent[indent.length - 1];
}

// Leading whitespace of the line containing `i`.
function indentOfLine(text: string, i: number): string {
  return /^[\t ]*/.exec(text.slice(text.lastIndexOf("\n", i - 1) + 1))?.[0] ?? "";
}

// Indentation for a new element in a multi-line array: whatever the array's
// first element already uses, so tabs stay tabs and the shape survives. The
// bracket's own line is not a reliable guide — it is usually followed by a blank
// line. Falls back to the closing bracket's indent for an array with no elements
// to copy from.
function elementIndentFor(text: string, open: number, close: number): string {
  const first = firstStringStart(text, open + 1, close);
  if (first >= 0) return indentOfLine(text, first);
  return childIndentOf(indentOfLine(text, close));
}

// Split a comment off the front of `s` (which is expected to be whitespace and
// possibly a comment). Returns the comment including its leading whitespace,
// and whatever follows it. A `//` runs to end of line; a block comment ends at
// its closer. Both are returned whole so the caller can re-emit the comment on
// the line it belongs to.
function splitTrailingComment(s: string): { comment: string; rest: string } {
  const lead = /^\s*/.exec(s)?.[0] ?? "";
  const body = s.slice(lead.length);
  if (body.startsWith("//")) {
    const nl = body.indexOf("\n");
    return { comment: s.slice(0, lead.length + (nl < 0 ? body.length : nl)), rest: nl < 0 ? "" : body.slice(nl) };
  }
  if (body.startsWith("/*")) {
    const end = body.indexOf("*/");
    if (end >= 0) {
      const stop = end + 2;
      return { comment: s.slice(0, lead.length + stop), rest: body.slice(stop) };
    }
  }
  return { comment: "", rest: s };
}

// End of the last *element* of the array whose interior is s.slice(from, to),
// or -1 if it is empty. A nested value is stepped over whole, because
// `["name", {opts}]` is one element and stopping inside the object would put the
// new entry in the middle of it. A trailing separator is not counted, so the
// answer is always the end of the last value.
function lastElementEnd(s: string, from: number, to: number): number {
  let end = -1;
  let i = from;
  while (i < to) {
    const c = s[i];
    if (WS.test(c)) { i += 1; continue; }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      if (nl < 0 || nl >= to) break;
      i = nl + 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      if (close < 0 || close >= to) break;
      i = close + 2;
      continue;
    }
    if (c === '"') { const stop = skipString(s, i); end = stop; i = stop; continue; }
    if (c === "{" || c === "[") {
      const stop = matchBracket(s, i);
      if (stop < 0 || stop > to) break;
      end = stop;
      i = stop;
      continue;
    }
    if (c === "," || c === "}" || c === "]") { i += 1; continue; }
    end = i + 1;
    i += 1;
  }
  return end;
}

// End of the last property value in s.slice(from, to), for the object case.
// There is no trailing separator to key off, so this tracks the end of each
// value and stops before any comment, which would swallow a separator.
function lastValueEnd(s: string, from: number, to: number): number {
  let end = -1;
  let i = from;
  while (i < to) {
    const c = s[i];
    if (WS.test(c)) { i += 1; continue; }
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      end = i;
      const nl = c === "/"
        ? s.indexOf("\n", i)
        : (() => { const cl = s.indexOf("*/", i + 2); return cl < 0 ? -1 : s.indexOf("\n", cl); })();
      if (nl < 0 || nl >= to) break;
      i = nl + 1;
      continue;
    }
    if (c === ",") { end = i; i += 1; continue; }
    if (c === '"') { const stop = skipString(s, i); end = stop; i = stop; continue; }
    if (c === "{" || c === "[") {
      const stop = matchBracket(s, i);
      if (stop < 0 || stop > to) break;
      end = stop;
      i = stop;
      continue;
    }
    if (c === "}" || c === "]") break;
    end = i + 1;
    i += 1;
  }
  return end;
}

function topLevelClose(text: string): number {
  const end = matchBracket(text, 0);
  return end < 0 ? text.length : end - 1;
}
