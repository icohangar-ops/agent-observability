import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// The db package throws at import time unless DATABASE_URL is set. It is present
// in the dev/test environment.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
import { pool } from "@workspace/db";
import type { NormalizedSpan } from "../lib/datadog";
import {
  loadDepartmentMap,
  resetDepartmentMapCache,
  buildCanonicalDepartments,
  departmentOf,
  groupByCost,
  type CostGroup,
} from "./traces";

// These tests exercise the REAL agents → employees → departments join that
// loadDepartmentMap runs (and the brief in-memory cache around it) against an
// actual Postgres instance. The rest of the trace suite stubs Datadog and never
// touches the DB, so a regression in the join (wrong column, dropped table) or
// the cache (serving stale data, never refreshing) would slip through there.
//
// Isolation: everything runs inside a single transaction on one client. TEMP
// tables shadow the real ones (pg_temp is first on the search path, so the
// unqualified table names in loadDepartmentMap's SQL resolve to them) and seed
// only the columns the join reads. Each test runs in its own BEGIN/ROLLBACK, so
// nothing touches real data and the temp tables vanish on rollback.

type PoolClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  release: () => void;
};

// Minimal NormalizedSpan builder; tests override only ml_app / cost / tags.
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

// Reproduce exactly what GET /traces/breakdown does for byDepartment: load the
// agent→department map, build the canonical casing map, then group spans by the
// derived department. Keeping this in lockstep with the route means the test
// breaks if the route's grouping wiring changes.
async function byDepartment(
  spans: NormalizedSpan[],
  exec: PoolClient,
): Promise<CostGroup[]> {
  const mlAppToDept = await loadDepartmentMap(exec);
  const canonical = buildCanonicalDepartments(spans, mlAppToDept);
  return groupByCost(spans, (s) => departmentOf(s, mlAppToDept, canonical));
}

function group(groups: CostGroup[], key: string): CostGroup | undefined {
  return groups.find((g) => g.key === key);
}

describe("loadDepartmentMap + breakdown byDepartment (real SQL)", () => {
  let client: PoolClient;

  before(async () => {
    client = (await pool.connect()) as unknown as PoolClient;
  });

  after(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    // A fresh cache so each test's injected client actually hits the DB rather
    // than returning a map cached by a previous case.
    resetDepartmentMapCache();
    await client.query("BEGIN");
    // TEMP tables shadow the real tables for the duration of the transaction.
    // Only the columns the join reads are declared.
    await client.query(`
      CREATE TEMP TABLE departments (id text PRIMARY KEY, name text NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE employees (
        id text PRIMARY KEY,
        department_id text NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE agents (
        id text PRIMARY KEY,
        employee_id text NOT NULL
      ) ON COMMIT DROP;
    `);
    // Two departments, an employee in each, and one agent per employee. The
    // agent id is the value a span carries in ml_app.
    await client.query(`
      INSERT INTO departments (id, name) VALUES ('d1', 'Engineering'), ('d2', 'Finance');
      INSERT INTO employees (id, department_id) VALUES ('e1', 'd1'), ('e2', 'd2');
      INSERT INTO agents (id, employee_id) VALUES ('support-bot', 'e1'), ('billing-agent', 'e2');
    `);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  test("joins agents → employees → departments into an ml_app → department map", async () => {
    const map = await loadDepartmentMap(client);
    assert.equal(map.get("support-bot"), "Engineering");
    assert.equal(map.get("billing-agent"), "Finance");
    assert.equal(map.size, 2);
  });

  test("omits agents whose employee or department row is missing", async () => {
    // An agent pointing at an employee that does not exist must not appear: the
    // inner joins drop it rather than surfacing a half-attributed row.
    await client.query(`INSERT INTO agents (id, employee_id) VALUES ('orphan-agent', 'missing')`);
    const map = await loadDepartmentMap(client);
    assert.equal(map.has("orphan-agent"), false);
    assert.equal(map.size, 2);
  });

  test("breakdown attributes spans to a department via their ml_app", async () => {
    const spans = [
      span({ spanId: "a", mlApp: "support-bot", estimatedCostUsd: 0.5, totalTokens: 10 }),
      span({ spanId: "b", mlApp: "support-bot", estimatedCostUsd: 0.25, totalTokens: 4 }),
      span({ spanId: "c", mlApp: "billing-agent", estimatedCostUsd: 0.25, totalTokens: 6 }),
    ];
    const groups = await byDepartment(spans, client);

    const eng = group(groups, "Engineering");
    assert.ok(eng, "expected an Engineering group");
    assert.equal(eng.spanCount, 2);
    assert.equal(eng.cost, 0.75);
    assert.equal(eng.totalTokens, 14);

    const fin = group(groups, "Finance");
    assert.ok(fin, "expected a Finance group");
    assert.equal(fin.spanCount, 1);
    assert.equal(fin.cost, 0.25);
  });

  test("breakdown buckets spans with an unmapped ml_app under (unattributed)", async () => {
    const spans = [
      span({ spanId: "a", mlApp: "support-bot", estimatedCostUsd: 0.5 }),
      span({ spanId: "b", mlApp: "ghost-agent", estimatedCostUsd: 0.3 }),
      span({ spanId: "c", mlApp: null, estimatedCostUsd: 0.2 }),
    ];
    const groups = await byDepartment(spans, client);

    assert.equal(group(groups, "Engineering")?.spanCount, 1);
    const unattributed = group(groups, "(unattributed)");
    assert.ok(unattributed, "expected an (unattributed) group");
    assert.equal(unattributed.spanCount, 2);
  });

  test("an explicit department tag wins over the ml_app's mapped department", async () => {
    // support-bot maps to Engineering, but the span tags it as Finance. The tag
    // is authoritative, so the span lands in Finance.
    const spans = [
      span({ spanId: "a", mlApp: "support-bot", tags: ["department:Finance"], estimatedCostUsd: 0.5 }),
    ];
    const groups = await byDepartment(spans, client);
    assert.equal(group(groups, "Finance")?.spanCount, 1);
    assert.equal(group(groups, "Engineering"), undefined);
  });

  test("directory casing wins so a lowercase tag does not split a department", async () => {
    // Datadog lowercases tag values: a span may carry department:engineering
    // while the directory says "Engineering". The canonical map (seeded from the
    // join) collapses both onto the directory label instead of two rows.
    const spans = [
      span({ spanId: "a", mlApp: "support-bot", estimatedCostUsd: 0.5 }),
      span({ spanId: "b", tags: ["department:engineering"], estimatedCostUsd: 0.5 }),
    ];
    const groups = await byDepartment(spans, client);
    const eng = group(groups, "Engineering");
    assert.ok(eng, "expected a single Engineering group");
    assert.equal(eng.spanCount, 2);
    assert.equal(group(groups, "engineering"), undefined);
  });

  describe("graceful degradation", () => {
    test("a DB error yields an empty map (everything becomes (unattributed))", async () => {
      // A client whose query always rejects simulates a broken/unavailable DB.
      // loadDepartmentMap must swallow it and return an empty map rather than
      // throwing and failing the whole breakdown route.
      const failing: PoolClient = {
        query: async () => {
          throw new Error("connection refused");
        },
        release: () => {},
      };
      const map = await loadDepartmentMap(failing);
      assert.equal(map.size, 0);

      const spans = [
        span({ spanId: "a", mlApp: "support-bot", estimatedCostUsd: 0.5 }),
        span({ spanId: "b", mlApp: "billing-agent", estimatedCostUsd: 0.5 }),
      ];
      const canonical = buildCanonicalDepartments(spans, map);
      const groups = groupByCost(spans, (s) => departmentOf(s, map, canonical));
      assert.equal(groups.length, 1);
      assert.equal(groups[0].key, "(unattributed)");
      assert.equal(groups[0].spanCount, 2);
    });

    test("a span tag still attributes even when the DB map is empty", async () => {
      // Degradation only loses the ml_app→department fallback; explicit tags are
      // independent of the DB, so a tagged span is still attributed.
      const map = new Map<string, string>();
      const spans = [
        span({ spanId: "a", mlApp: "support-bot", tags: ["team:Sales"], estimatedCostUsd: 0.5 }),
        span({ spanId: "b", mlApp: "support-bot", estimatedCostUsd: 0.5 }),
      ];
      const canonical = buildCanonicalDepartments(spans, map);
      const groups = groupByCost(spans, (s) => departmentOf(s, map, canonical));
      assert.equal(group(groups, "Sales")?.spanCount, 1);
      assert.equal(group(groups, "(unattributed)")?.spanCount, 1);
    });
  });

  describe("in-memory cache", () => {
    test("serves the cached map without re-querying within the TTL", async () => {
      let calls = 0;
      const counting: PoolClient = {
        query: async (text: string, params?: unknown[]) => {
          calls += 1;
          return client.query(text, params);
        },
        release: () => {},
      };
      const first = await loadDepartmentMap(counting);
      const second = await loadDepartmentMap(counting);
      assert.equal(calls, 1, "second call within the TTL must not hit the DB");
      assert.equal(first, second, "the same cached map instance is returned");
      assert.equal(second.get("support-bot"), "Engineering");
    });

    test("re-queries after the cache is reset (picks up directory changes)", async () => {
      const before = await loadDepartmentMap(client);
      assert.equal(before.get("billing-agent"), "Finance");

      // Reassign the agent to Engineering, then reset the cache (a stand-in for
      // TTL expiry) and confirm the next load reflects the directory change.
      await client.query(`UPDATE agents SET employee_id = 'e1' WHERE id = 'billing-agent'`);
      resetDepartmentMapCache();

      const after = await loadDepartmentMap(client);
      assert.equal(after.get("billing-agent"), "Engineering");
    });

    test("moving an employee re-attributes ALL of that employee's agents", async () => {
      // An org change: an employee (and the whole team of agents they own) is
      // moved from one department to another. This differs from reassigning a
      // single agent — the agents' employee_id does not change, only the
      // employee's department_id. Every agent owned by that employee must
      // re-attribute to the new department on the next cache refresh.
      await client.query(`
        INSERT INTO agents (id, employee_id) VALUES
          ('triage-bot', 'e1'),
          ('deploy-bot', 'e1');
      `);

      const before = await loadDepartmentMap(client);
      assert.equal(before.get("support-bot"), "Engineering");
      assert.equal(before.get("triage-bot"), "Engineering");
      assert.equal(before.get("deploy-bot"), "Engineering");

      // Move employee e1 from Engineering (d1) to Finance (d2). A regression
      // that joined on the wrong key (e.g. agent→department directly) would
      // miss this and keep the agents in Engineering.
      await client.query(`UPDATE employees SET department_id = 'd2' WHERE id = 'e1'`);
      resetDepartmentMapCache();

      const after = await loadDepartmentMap(client);
      assert.equal(after.get("support-bot"), "Finance");
      assert.equal(after.get("triage-bot"), "Finance");
      assert.equal(after.get("deploy-bot"), "Finance");
      // The other employee's agent is untouched by the move.
      assert.equal(after.get("billing-agent"), "Finance");
    });
  });
});
