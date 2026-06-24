import { test } from "vitest";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { prettyPrint, highlightJson } from "./json-highlight";

// --- prettyPrint -----------------------------------------------------------

test("prettyPrint formats a valid JSON object and flags it as JSON", () => {
  const result = prettyPrint('{"b":2,"a":1}');
  assert.equal(result.isJson, true);
  assert.equal(result.text, '{\n  "b": 2,\n  "a": 1\n}');
});

test("prettyPrint formats a valid JSON array and flags it as JSON", () => {
  const result = prettyPrint("[1,2,3]");
  assert.equal(result.isJson, true);
  assert.equal(result.text, "[\n  1,\n  2,\n  3\n]");
});

test("prettyPrint pretty-prints nested structures", () => {
  const result = prettyPrint('{"outer":{"inner":[true,null]}}');
  assert.equal(result.isJson, true);
  assert.equal(
    result.text,
    '{\n  "outer": {\n    "inner": [\n      true,\n      null\n    ]\n  }\n}',
  );
});

test("prettyPrint handles surrounding whitespace before parsing", () => {
  const result = prettyPrint('   {"a":1}   ');
  assert.equal(result.isJson, true);
  assert.equal(result.text, '{\n  "a": 1\n}');
});

test("prettyPrint returns the original text for JS-object literals with single quotes", () => {
  const input = "{'a': 1}";
  const result = prettyPrint(input);
  assert.equal(result.isJson, false);
  assert.equal(result.text, input);
});

test("prettyPrint returns the original text for malformed JSON that looks like JSON", () => {
  const input = "{a: 1, b: 2,}";
  const result = prettyPrint(input);
  assert.equal(result.isJson, false);
  assert.equal(result.text, input);
});

test("prettyPrint leaves plain text untouched", () => {
  const input = "just some plain text";
  const result = prettyPrint(input);
  assert.equal(result.isJson, false);
  assert.equal(result.text, input);
});

test("prettyPrint does not treat text that only starts with a brace as JSON", () => {
  const input = "{ not closed properly";
  const result = prettyPrint(input);
  assert.equal(result.isJson, false);
  assert.equal(result.text, input);
});

// --- highlightJson ---------------------------------------------------------

// Reduce the highlightJson output into ordered { text, className } tokens.
// Plain-string nodes are punctuation/whitespace passthrough (className: null);
// element nodes carry the themed className that classifies the token.
function classify(nodes: ReactNode[]): Array<{ text: string; className: string | null }> {
  return nodes.map((node) => {
    if (isValidElement(node)) {
      const el = node as ReactElement<{ className: string; children: string }>;
      return { text: el.props.children, className: el.props.className };
    }
    return { text: String(node), className: null };
  });
}

// Find the classified token whose text matches exactly (ignoring passthrough).
function tokenFor(nodes: ReactNode[], text: string) {
  return classify(nodes).find((t) => t.className !== null && t.text === text);
}

test("highlightJson classifies object keys distinctly from string values", () => {
  const { text } = prettyPrint('{"name":"alice"}');
  const nodes = highlightJson(text);
  const keyToken = tokenFor(nodes, '"name"');
  const valueToken = tokenFor(nodes, '"alice"');
  assert.ok(keyToken, "expected a key token");
  assert.ok(valueToken, "expected a value token");
  assert.match(keyToken!.className!, /text-sky-700/);
  assert.match(valueToken!.className!, /text-emerald-600/);
});

test("highlightJson classifies numbers (including negative, decimal, exponent)", () => {
  const nodes = highlightJson('[42, -3.14, 1e3]');
  for (const num of ["42", "-3.14", "1e3"]) {
    const token = tokenFor(nodes, num);
    assert.ok(token, `expected a token for ${num}`);
    assert.match(token!.className!, /text-amber-600/);
  }
});

test("highlightJson classifies booleans", () => {
  const nodes = highlightJson("[true, false]");
  for (const bool of ["true", "false"]) {
    const token = tokenFor(nodes, bool);
    assert.ok(token, `expected a token for ${bool}`);
    assert.match(token!.className!, /text-violet-600/);
  }
});

test("highlightJson classifies null", () => {
  const nodes = highlightJson("[null]");
  const token = tokenFor(nodes, "null");
  assert.ok(token, "expected a null token");
  assert.match(token!.className!, /text-rose-600/);
});

test("highlightJson emits punctuation and whitespace as plain passthrough strings", () => {
  const nodes = highlightJson('{"a": 1}');
  const passthrough = classify(nodes)
    .filter((t) => t.className === null)
    .map((t) => t.text)
    .join("");
  // The non-token characters (brace, colon, space, brace) survive verbatim.
  assert.equal(passthrough, "{: }");
});

test("highlightJson reassembles to the original input when concatenated", () => {
  const { text } = prettyPrint('{"id":1,"ok":true,"note":null,"tags":["a","b"]}');
  const nodes = highlightJson(text);
  const rebuilt = classify(nodes)
    .map((t) => t.text)
    .join("");
  assert.equal(rebuilt, text);
});

test("highlightJson returns a single passthrough node for non-JSON text", () => {
  const nodes = highlightJson("no tokens here");
  const tokens = classify(nodes);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].className, null);
  assert.equal(tokens[0].text, "no tokens here");
});
