import { describe, test } from "node:test";
import assert from "node:assert/strict";
// The db package throws at import time unless DATABASE_URL is set. It is present
// in the dev/test environment; this fallback keeps the suite runnable elsewhere.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
import { budgetStatus } from "./observability";

// budgetStatus is a pure function, so these exercise its branches directly
// without standing up the HTTP server.
describe("budgetStatus", () => {
  test("returns 'ok' for spend well under the threshold", () => {
    assert.equal(budgetStatus(0, 100), "ok");
    assert.equal(budgetStatus(30, 100), "ok");
    assert.equal(budgetStatus(79.99, 100), "ok");
  });

  test("returns 'warning' once utilization reaches the 0.8 threshold", () => {
    assert.equal(budgetStatus(80, 100), "warning"); // exactly 0.8
    assert.equal(budgetStatus(90, 100), "warning");
    assert.equal(budgetStatus(99.99, 100), "warning");
  });

  test("returns 'over' once utilization reaches 1", () => {
    assert.equal(budgetStatus(100, 100), "over"); // exactly 1
    assert.equal(budgetStatus(150, 100), "over");
  });

  test("treats a non-positive amount as 'ok' regardless of spend", () => {
    assert.equal(budgetStatus(50, 0), "ok");
    assert.equal(budgetStatus(50, -10), "ok");
    assert.equal(budgetStatus(0, 0), "ok");
  });
});
