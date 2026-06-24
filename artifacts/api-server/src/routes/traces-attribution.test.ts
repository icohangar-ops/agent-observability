import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedSpan } from "../lib/datadog";
import { departmentOf, groupByCost } from "./traces";

// Build a NormalizedSpan with sensible defaults; tests override only the fields
// relevant to attribution/cost grouping so each case stays readable.
function span(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    spanId: "s",
    traceId: "t",
    parentId: null,
    name: "span",
    kind: "llm",
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
    status: "ok",
    timestamp: "2026-01-01T00:00:00.000Z",
    mlApp: null,
    tags: [],
    input: null,
    output: null,
    ...overrides,
  };
}

// Floating-point safe equality for summed costs / shares.
function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

describe("departmentOf", () => {
  const emptyMap = new Map<string, string>();
  // An empty canonical map means tag-derived names are returned verbatim (the
  // function does `canonical.get(value.toLowerCase()) ?? value`), which keeps
  // these cases focused on the tag/ml_app/fallback branching.
  const noCanon = new Map<string, string>();

  test("prefers a department: tag over everything else", () => {
    const s = span({ tags: ["department:Engineering"], mlApp: "agent-1" });
    const map = new Map([["agent-1", "Support"]]);
    // Even though the ml_app maps to Support, the explicit tag wins.
    assert.equal(departmentOf(s, map, noCanon), "Engineering");
  });

  test("accepts dept: and team: tag aliases, case-insensitively", () => {
    assert.equal(departmentOf(span({ tags: ["dept:Finance"] }), emptyMap, noCanon), "Finance");
    assert.equal(departmentOf(span({ tags: ["team:Sales"] }), emptyMap, noCanon), "Sales");
    assert.equal(departmentOf(span({ tags: ["DEPARTMENT:Legal"] }), emptyMap, noCanon), "Legal");
    assert.equal(departmentOf(span({ tags: ["Team:Ops"] }), emptyMap, noCanon), "Ops");
  });

  test("trims surrounding whitespace from the tag value", () => {
    assert.equal(
      departmentOf(span({ tags: ["department:  Platform  "] }), emptyMap, noCanon),
      "Platform",
    );
  });

  test("ignores a department tag whose value is blank and falls through", () => {
    // A "department:" tag with an empty/whitespace value must not win; the span
    // has no other signal, so it lands in (unattributed).
    assert.equal(
      departmentOf(span({ tags: ["department:   "] }), emptyMap, noCanon),
      "(unattributed)",
    );
  });

  test("uses the first matching department tag when several are present", () => {
    const s = span({ tags: ["env:prod", "team:Growth", "department:Marketing"] });
    assert.equal(departmentOf(s, emptyMap, noCanon), "Growth");
  });

  test("ignores unrelated tags that merely contain the keyword", () => {
    // "subteam" / "department_id" are not the department/dept/team prefixes.
    const s = span({ tags: ["subteam:foo", "department_id:42"] });
    assert.equal(departmentOf(s, emptyMap, noCanon), "(unattributed)");
  });

  test("collapses a tag's casing onto the canonical/directory label", () => {
    // Datadog lowercases tag values; the canonical map upgrades "finance" to the
    // directory's "Finance" so the same department doesn't split into two rows.
    const canonical = new Map([["finance", "Finance"]]);
    assert.equal(departmentOf(span({ tags: ["department:finance"] }), emptyMap, canonical), "Finance");
  });

  test("falls back to the ml_app -> department DB mapping when no tag is present", () => {
    const map = new Map([
      ["support-bot", "Customer Success"],
      ["billing-agent", "Finance"],
    ]);
    assert.equal(departmentOf(span({ mlApp: "support-bot" }), map, noCanon), "Customer Success");
    assert.equal(departmentOf(span({ mlApp: "billing-agent" }), map, noCanon), "Finance");
  });

  test("falls back to (unattributed) when the ml_app is not in the map", () => {
    const map = new Map([["support-bot", "Customer Success"]]);
    assert.equal(departmentOf(span({ mlApp: "unknown-agent" }), map, noCanon), "(unattributed)");
  });

  test("falls back to (unattributed) when there is neither a tag nor an ml_app", () => {
    assert.equal(departmentOf(span({ mlApp: null, tags: [] }), emptyMap, noCanon), "(unattributed)");
  });
});

describe("groupByCost", () => {
  const keyOf = (s: NormalizedSpan) => s.model ?? "(no model)";

  test("sums cost, span count and tokens per group", () => {
    const spans = [
      span({ model: "gpt-4o", estimatedCostUsd: 0.5, totalTokens: 15 }),
      span({ model: "gpt-4o", estimatedCostUsd: 0.2, totalTokens: 20 }),
      span({ model: "claude-3", estimatedCostUsd: 0.2, totalTokens: 40 }),
    ];
    const groups = groupByCost(spans, keyOf);

    const gpt = groups.find((g) => g.key === "gpt-4o")!;
    approx(gpt.cost, 0.7);
    assert.equal(gpt.spanCount, 2);
    assert.equal(gpt.totalTokens, 35);

    const claude = groups.find((g) => g.key === "claude-3")!;
    approx(claude.cost, 0.2);
    assert.equal(claude.spanCount, 1);
    assert.equal(claude.totalTokens, 40);
  });

  test("sorts groups by cost descending", () => {
    const spans = [
      span({ model: "cheap", estimatedCostUsd: 0.1 }),
      span({ model: "pricey", estimatedCostUsd: 0.9 }),
      span({ model: "mid", estimatedCostUsd: 0.4 }),
    ];
    assert.deepEqual(
      groupByCost(spans, keyOf).map((g) => g.key),
      ["pricey", "mid", "cheap"],
    );
  });

  test("computes costShare as each group's fraction of the total cost", () => {
    const spans = [
      span({ model: "a", estimatedCostUsd: 0.75 }),
      span({ model: "b", estimatedCostUsd: 0.25 }),
    ];
    const groups = groupByCost(spans, keyOf);
    approx(groups[0].costShare, 0.75);
    approx(groups[1].costShare, 0.25);
    approx(
      groups.reduce((acc, g) => acc + g.costShare, 0),
      1,
    );
  });

  test("applies the key function's fallback for missing keys", () => {
    const spans = [span({ model: null, estimatedCostUsd: 0.1 })];
    const groups = groupByCost(spans, keyOf);
    assert.equal(groups[0].key, "(no model)");
  });

  test("returns an empty array for no spans", () => {
    assert.deepEqual(groupByCost([], keyOf), []);
  });

  test("reports a zero costShare for every group when the total cost is zero", () => {
    // Spans with no estimated cost (e.g. agent steps) must not divide by zero.
    const spans = [
      span({ model: "a", estimatedCostUsd: 0, totalTokens: 5 }),
      span({ model: "b", estimatedCostUsd: 0, totalTokens: 7 }),
    ];
    const groups = groupByCost(spans, keyOf);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.costShare === 0));
    assert.ok(groups.every((g) => g.cost === 0));
  });

  test("groups by ml_app as well via a different key function", () => {
    const byApp = (s: NormalizedSpan) => s.mlApp ?? "(no app)";
    const spans = [
      span({ mlApp: "support-bot", estimatedCostUsd: 0.5 }),
      span({ mlApp: "support-bot", estimatedCostUsd: 0.2 }),
      span({ mlApp: null, estimatedCostUsd: 0.1 }),
    ];
    const groups = groupByCost(spans, byApp);
    assert.deepEqual(
      groups.map((g) => g.key),
      ["support-bot", "(no app)"],
    );
    approx(groups[0].cost, 0.7);
    assert.equal(groups[0].spanCount, 2);
  });
});
