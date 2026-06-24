import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// The db package throws at import time unless DATABASE_URL is set. It is present
// in the dev/test environment.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
import { pool } from "@workspace/db";
import { budgetRows } from "./observability";

// Minimal structural type for the transaction client we use, so we don't depend
// on `pg` being a directly-resolvable import in this package.
type PoolClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  release: () => void;
};

// These tests exercise the REAL current-month SQL window that budgetRows uses
// (CURRENT_MONTH_FILTER) against an actual Postgres instance. The rest of the
// observability suite stubs `pool.query`, so the date-boundary logic is never
// truly executed there. Here we run the genuine query so an off-by-one in the
// month boundary (e.g. leaking last month, or dropping the first day) fails.
//
// Isolation: everything runs inside a single transaction on one client. We
// create TEMP tables that shadow the real ones (pg_temp is first on the search
// path, so the unqualified table names in budgetRows resolve to them) and seed
// only what the budget spend query joins. Each test runs in its own
// BEGIN/ROLLBACK, so nothing touches real data and temp tables vanish on
// rollback.

// gpt-4o-style pricing: $5 / 1M input tokens, $10 / 1M output tokens.
const INPUT_PRICE = 5;
const OUTPUT_PRICE = 10;
const BUDGET_AMOUNT = 100;

// Boundary timestamps expressed as SQL so Postgres (not JS) computes them,
// avoiding any client/server timezone drift.
const FIRST_INSTANT = `date_trunc('month', now())`;
const LAST_INSTANT = `date_trunc('month', now()) + interval '1 month' - interval '1 microsecond'`;
const PREV_MONTH_LAST = `date_trunc('month', now()) - interval '1 microsecond'`;
const NEXT_MONTH_FIRST = `date_trunc('month', now()) + interval '1 month'`;

// Cost in USD for an event with the given tokens at the seeded model's pricing.
function cost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_PRICE +
    (outputTokens / 1_000_000) * OUTPUT_PRICE
  );
}

describe("budget current-month spend window (real SQL)", () => {
  let client: PoolClient;

  before(async () => {
    client = (await pool.connect()) as unknown as PoolClient;
  });

  after(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    // TEMP tables shadow the real tables for the duration of the transaction.
    // Only the columns budgetRows reads are declared.
    await client.query(`
      CREATE TEMP TABLE departments (id text PRIMARY KEY, name text NOT NULL) ON COMMIT DROP;
      CREATE TEMP TABLE models (
        id text PRIMARY KEY,
        name text NOT NULL,
        input_price_per_million numeric NOT NULL,
        output_price_per_million numeric NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE employees (
        id text PRIMARY KEY,
        department_id text NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE agents (
        id text PRIMARY KEY,
        employee_id text NOT NULL,
        model_id text NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE usage_events (
        id serial PRIMARY KEY,
        agent_id text NOT NULL,
        timestamp timestamptz NOT NULL,
        input_tokens integer NOT NULL,
        output_tokens integer NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE budgets (
        id serial PRIMARY KEY,
        department_id text NOT NULL,
        model_id text,
        amount numeric NOT NULL
      ) ON COMMIT DROP;
    `);
    // One department, one model, one employee, one agent, one department-wide
    // budget. Spend is driven entirely by which usage_events each test inserts.
    await client.query(`INSERT INTO departments (id, name) VALUES ('d1', 'Engineering')`);
    await client.query(
      `INSERT INTO models (id, name, input_price_per_million, output_price_per_million)
       VALUES ('m1', 'gpt-4o', $1, $2)`,
      [INPUT_PRICE, OUTPUT_PRICE],
    );
    await client.query(`INSERT INTO employees (id, department_id) VALUES ('e1', 'd1')`);
    await client.query(
      `INSERT INTO agents (id, employee_id, model_id) VALUES ('a1', 'e1', 'm1')`,
    );
    await client.query(
      `INSERT INTO budgets (department_id, model_id, amount) VALUES ('d1', NULL, $1)`,
      [BUDGET_AMOUNT],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // Insert a usage event for agent a1 at a SQL-computed timestamp.
  async function seedEvent(
    tsExpr: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO usage_events (agent_id, timestamp, input_tokens, output_tokens)
       VALUES ('a1', ${tsExpr}, $1, $2)`,
      [inputTokens, outputTokens],
    );
  }

  async function spendForD1(): Promise<number> {
    const rows = await budgetRows("d1", client);
    assert.equal(rows.length, 1, "expected exactly one budget row for d1");
    return rows[0].spend;
  }

  test("counts an event at the first instant of the month", async () => {
    await seedEvent(FIRST_INSTANT, 1_000_000, 0);
    const spend = await spendForD1();
    assert.equal(spend, cost(1_000_000, 0));
  });

  test("counts an event at the last instant of the month", async () => {
    await seedEvent(LAST_INSTANT, 0, 1_000_000);
    const spend = await spendForD1();
    assert.equal(spend, cost(0, 1_000_000));
  });

  test("excludes an event at the last instant of the previous month", async () => {
    await seedEvent(PREV_MONTH_LAST, 1_000_000, 1_000_000);
    const spend = await spendForD1();
    assert.equal(spend, 0);
  });

  test("excludes an event at the first instant of the next month", async () => {
    await seedEvent(NEXT_MONTH_FIRST, 1_000_000, 1_000_000);
    const spend = await spendForD1();
    assert.equal(spend, 0);
  });

  test("sums only the events inside the current calendar month", async () => {
    // Two in-window events (counted) and two just-outside ones (ignored).
    await seedEvent(FIRST_INSTANT, 1_000_000, 0); // +$5
    await seedEvent(LAST_INSTANT, 0, 1_000_000); // +$10
    await seedEvent(PREV_MONTH_LAST, 2_000_000, 2_000_000); // ignored
    await seedEvent(NEXT_MONTH_FIRST, 2_000_000, 2_000_000); // ignored

    const rows = await budgetRows("d1", client);
    assert.equal(rows.length, 1);
    const expectedSpend = cost(1_000_000, 0) + cost(0, 1_000_000); // $15
    assert.equal(rows[0].spend, expectedSpend);
    assert.equal(rows[0].amount, BUDGET_AMOUNT);
    assert.equal(rows[0].utilization, expectedSpend / BUDGET_AMOUNT);
    assert.equal(rows[0].status, "ok");
  });

  test("reports the period as the current calendar month (YYYY-MM)", async () => {
    await seedEvent(FIRST_INSTANT, 1_000_000, 0);
    const rows = await budgetRows("d1", client);
    const periodRes = await client.query<{ p: string }>(
      `SELECT to_char(date_trunc('month', now()), 'YYYY-MM') AS p`,
    );
    assert.equal(rows[0].period, periodRes.rows[0].p);
  });
});
