import { test } from "vitest";
import assert from "node:assert/strict";
import {
  computeDepths,
  projectMs,
  projectMsInverse,
  type DepthSpan,
  type ProjectOptions,
} from "./timeline";

// --- computeDepths ---------------------------------------------------------

test("computeDepths treats a span with no parent as a root (depth 0)", () => {
  const depths = computeDepths([{ spanId: "a", parentId: null }]);
  assert.equal(depths.get("a"), 0);
});

test("computeDepths treats a parent not in the trace as a root", () => {
  const depths = computeDepths([{ spanId: "a", parentId: "missing" }]);
  assert.equal(depths.get("a"), 0);
});

test("computeDepths increments depth along a nested chain", () => {
  const spans: DepthSpan[] = [
    { spanId: "root", parentId: null },
    { spanId: "child", parentId: "root" },
    { spanId: "grandchild", parentId: "child" },
  ];
  const depths = computeDepths(spans);
  assert.equal(depths.get("root"), 0);
  assert.equal(depths.get("child"), 1);
  assert.equal(depths.get("grandchild"), 2);
});

test("computeDepths handles siblings sharing one parent", () => {
  const spans: DepthSpan[] = [
    { spanId: "root", parentId: null },
    { spanId: "a", parentId: "root" },
    { spanId: "b", parentId: "root" },
  ];
  const depths = computeDepths(spans);
  assert.equal(depths.get("a"), 1);
  assert.equal(depths.get("b"), 1);
});

test("computeDepths resolves depth regardless of span order", () => {
  // Child appears before its parent in the array.
  const spans: DepthSpan[] = [
    { spanId: "child", parentId: "root" },
    { spanId: "root", parentId: null },
  ];
  const depths = computeDepths(spans);
  assert.equal(depths.get("root"), 0);
  assert.equal(depths.get("child"), 1);
});

test("computeDepths is cycle-safe for a two-node loop", () => {
  // a -> b -> a. Neither should recurse forever; the loop-closing edge is
  // treated as a root so depths stay finite.
  const spans: DepthSpan[] = [
    { spanId: "a", parentId: "b" },
    { spanId: "b", parentId: "a" },
  ];
  const depths = computeDepths(spans);
  assert.equal(depths.get("a"), 1);
  assert.equal(depths.get("b"), 0);
});

test("computeDepths is cycle-safe for a self-referential span", () => {
  const depths = computeDepths([{ spanId: "a", parentId: "a" }]);
  // parentId === own spanId is pre-seeded into `seen`, so it stays a root.
  assert.equal(depths.get("a"), 0);
});

test("computeDepths produces an entry for every span", () => {
  const spans: DepthSpan[] = [
    { spanId: "a", parentId: null },
    { spanId: "b", parentId: "a" },
    { spanId: "c", parentId: "b" },
  ];
  const depths = computeDepths(spans);
  assert.equal(depths.size, 3);
});

// --- projectMs -------------------------------------------------------------

const linear = (windowStart: number, windowEnd: number): ProjectOptions => ({
  windowStart,
  windowEnd,
  scale: "linear",
});

const log = (windowStart: number, windowEnd: number): ProjectOptions => ({
  windowStart,
  windowEnd,
  scale: "log",
});

test("projectMs returns 0 when the window has zero duration", () => {
  assert.equal(projectMs(50, linear(0, 0)), 0);
});

test("projectMs returns 0 when the window has negative duration", () => {
  assert.equal(projectMs(50, linear(100, 0)), 0);
});

test("projectMs maps linear offsets across 0..100", () => {
  const opts = linear(0, 1000);
  assert.equal(projectMs(0, opts), 0);
  assert.equal(projectMs(250, opts), 25);
  assert.equal(projectMs(500, opts), 50);
  assert.equal(projectMs(1000, opts), 100);
});

test("projectMs clamps offsets below the window start to 0", () => {
  assert.equal(projectMs(-500, linear(0, 1000)), 0);
});

test("projectMs clamps offsets beyond the window end to 100", () => {
  assert.equal(projectMs(5000, linear(0, 1000)), 100);
});

test("projectMs honors a non-zero window start (zoomed window)", () => {
  const opts = linear(200, 700);
  assert.equal(projectMs(200, opts), 0);
  assert.equal(projectMs(450, opts), 50);
  assert.equal(projectMs(700, opts), 100);
  // Below/above the zoomed window clamp to the edges.
  assert.equal(projectMs(0, opts), 0);
  assert.equal(projectMs(1000, opts), 100);
});

test("projectMs log scale anchors the window endpoints at 0 and 100", () => {
  const opts = log(0, 1000);
  assert.equal(projectMs(0, opts), 0);
  assert.ok(Math.abs(projectMs(1000, opts) - 100) < 1e-9);
});

test("projectMs log scale pushes the midpoint past 50% (compression)", () => {
  // Log compresses long stretches: the halfway offset lands well above 50%,
  // giving short early spans more room.
  const opts = log(0, 1000);
  const mid = projectMs(500, opts);
  assert.ok(mid > 50, `expected log midpoint > 50, got ${mid}`);
});

test("projectMs log scale is monotonically increasing", () => {
  const opts = log(0, 1000);
  let prev = -Infinity;
  for (const ms of [0, 1, 10, 100, 500, 999, 1000]) {
    const pct = projectMs(ms, opts);
    assert.ok(pct >= prev, `expected non-decreasing projection at ${ms}ms`);
    prev = pct;
  }
});

// --- projectMsInverse ------------------------------------------------------

test("projectMsInverse returns 0 for a zero-duration window", () => {
  assert.equal(projectMsInverse(50, linear(0, 0)), 0);
});

test("projectMsInverse maps linear percentages back to offsets", () => {
  const opts = linear(0, 1000);
  assert.equal(projectMsInverse(0, opts), 0);
  assert.equal(projectMsInverse(25, opts), 250);
  assert.equal(projectMsInverse(100, opts), 1000);
});

test("projectMsInverse clamps percentages to 0..100", () => {
  const opts = linear(0, 1000);
  assert.equal(projectMsInverse(-20, opts), 0);
  assert.equal(projectMsInverse(150, opts), 1000);
});

test("projectMsInverse offsets results by a non-zero window start", () => {
  const opts = linear(200, 700);
  assert.equal(projectMsInverse(0, opts), 200);
  assert.equal(projectMsInverse(100, opts), 700);
  assert.equal(projectMsInverse(50, opts), 450);
});

test("projectMsInverse inverts projectMs for linear scale", () => {
  const opts = linear(0, 1000);
  for (const ms of [0, 125, 333, 750, 1000]) {
    const roundTrip = projectMsInverse(projectMs(ms, opts), opts);
    assert.ok(Math.abs(roundTrip - ms) < 1e-6, `round-trip failed at ${ms}`);
  }
});

test("projectMsInverse inverts projectMs for log scale", () => {
  const opts = log(0, 1000);
  for (const ms of [0, 1, 10, 250, 999, 1000]) {
    const roundTrip = projectMsInverse(projectMs(ms, opts), opts);
    assert.ok(Math.abs(roundTrip - ms) < 1e-6, `log round-trip failed at ${ms}`);
  }
});
