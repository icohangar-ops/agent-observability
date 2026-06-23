import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
// The db package throws at import time unless DATABASE_URL is set. It is present
// in the dev/test environment; this fallback keeps the suite runnable elsewhere.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
import { pool } from "@workspace/db";
import app from "../app";

// --- Stub the Postgres pool -------------------------------------------------
// observability.ts talks to Postgres exclusively through `pool.query`. We replace
// that single method with an in-memory dispatcher so tests never open a real
// connection. The pool object is a shared singleton, so mutating it here affects
// the same reference the routes import.

type Row = Record<string, unknown>;
interface QueryResult {
  rows: Row[];
  rowCount: number;
}

interface Call {
  sql: string;
  params: unknown[];
}
let calls: Call[] = [];

// When set, the dispatcher returns empty/zeroed result sets to exercise the
// "no data" code paths. Aggregate queries (SELECT SUM/COUNT ...) always yield a
// single row even on an empty table, so those still return one zeroed row.
let emptyData = false;
// When set, every query rejects to exercise the error path.
let failNextQuery = false;

// Seed budgets behave as a tiny mutable store so PUT/DELETE behave realistically.
interface BudgetRecord {
  id: number;
  departmentId: string;
  modelId: string | null;
  amount: number;
}
let budgets: BudgetRecord[] = [];
let nextBudgetId = 1;

const DEPARTMENTS: Record<string, string> = {
  d1: "Engineering",
  d2: "Sales",
};
const MODELS: Record<string, string> = {
  m1: "gpt-4o",
  m2: "claude-3",
};
const EMPLOYEES: Record<string, { name: string; deptId: string }> = {
  e1: { name: "Alice", deptId: "d1" },
  e2: { name: "Bob", deptId: "d2" },
};
const AGENTS: Record<string, { employeeId: string }> = {
  a1: { employeeId: "e1" },
  a2: { employeeId: "e2" },
};
// Current-month spend per department, used by budgetRows.
const SPEND_BY_DEPT: Record<string, number> = { d1: 30, d2: 10 };

// Pull the value bound to e.g. `a.id = $2` out of the params array.
function paramFor(sql: string, marker: RegExp, params: unknown[]): unknown {
  const m = sql.match(marker);
  if (!m) return undefined;
  return params[Number(m[1]) - 1];
}

function ok(rows: Row[]): QueryResult {
  return { rows, rowCount: rows.length };
}

const EMP_ROWS: Record<string, Row> = {
  e1: {
    id: "e1",
    name: "Alice",
    role: "Engineer",
    access_tier: "frontier",
    department_id: "d1",
    department_name: "Engineering",
    cost: 30,
    tokens: 300,
    input_tokens: 200,
    output_tokens: 100,
    agent_count: 1,
    run_count: 3,
  },
  e2: {
    id: "e2",
    name: "Bob",
    role: "Rep",
    access_tier: "routine",
    department_id: "d2",
    department_name: "Sales",
    cost: 10,
    tokens: 100,
    input_tokens: 60,
    output_tokens: 40,
    agent_count: 1,
    run_count: 1,
  },
};

const AGENT_ROWS: Record<string, Row> = {
  a1: {
    id: "a1",
    name: "Helper",
    purpose: "support",
    status: "active",
    employee_id: "e1",
    employee_name: "Alice",
    department_id: "d1",
    department_name: "Engineering",
    model_id: "m1",
    model_name: "gpt-4o",
    provider: "openai",
    model_tier: "frontier",
    created_at: "2026-01-01T00:00:00Z",
    last_active_at: "2026-06-01T00:00:00Z",
    cost: 30,
    tokens: 300,
    input_tokens: 200,
    output_tokens: 100,
    run_count: 3,
  },
  a2: {
    id: "a2",
    name: "Closer",
    purpose: "sales",
    status: "idle",
    employee_id: "e2",
    employee_name: "Bob",
    department_id: "d2",
    department_name: "Sales",
    model_id: "m2",
    model_name: "claude-3",
    provider: "anthropic",
    model_tier: "research",
    created_at: "2026-02-01T00:00:00Z",
    last_active_at: "2026-06-02T00:00:00Z",
    cost: 10,
    tokens: 100,
    input_tokens: 60,
    output_tokens: 40,
    run_count: 1,
  },
};

function budgetRowsFor(departmentId?: string): Row[] {
  return budgets
    .filter((b) => !departmentId || b.departmentId === departmentId)
    .map((b) => ({
      id: b.id,
      department_id: b.departmentId,
      department_name: DEPARTMENTS[b.departmentId] ?? "Unknown",
      model_id: b.modelId,
      model_name: b.modelId ? (MODELS[b.modelId] ?? null) : null,
      amount: b.amount,
      period: "2026-06",
      spend: b.modelId ? 0 : (SPEND_BY_DEPT[b.departmentId] ?? 0),
    }));
}

function dispatch(sql: string, params: unknown[]): QueryResult {
  // --- budgets writes (order matters: most specific first) ---
  if (sql.includes("DELETE FROM budgets")) {
    const id = Number(params[0]);
    const before = budgets.length;
    budgets = budgets.filter((b) => b.id !== id);
    return { rows: [], rowCount: before - budgets.length };
  }
  if (sql.includes("UPDATE budgets SET amount")) {
    const amount = Number(params[0]);
    const id = Number(params[1]);
    const b = budgets.find((x) => x.id === id);
    if (b) b.amount = amount;
    return { rows: [], rowCount: b ? 1 : 0 };
  }
  if (sql.includes("INSERT INTO budgets")) {
    const rec: BudgetRecord = {
      id: nextBudgetId++,
      departmentId: String(params[0]),
      modelId: params[1] === null ? null : String(params[1]),
      amount: Number(params[2]),
    };
    budgets.push(rec);
    return ok([{ id: rec.id }]);
  }
  if (sql.includes("SELECT id FROM departments WHERE id")) {
    const id = String(params[0]);
    return id in DEPARTMENTS ? ok([{ id }]) : ok([]);
  }
  if (sql.includes("SELECT id FROM models WHERE id")) {
    const id = String(params[0]);
    return id in MODELS ? ok([{ id }]) : ok([]);
  }
  if (sql.includes("SELECT id FROM budgets")) {
    // existing-budget lookup for the PUT upsert
    const deptId = String(params[0]);
    const modelId = params[1] === null ? null : String(params[1]);
    const match = budgets.find(
      (b) => b.departmentId === deptId && b.modelId === modelId,
    );
    return match ? ok([{ id: match.id }]) : ok([]);
  }
  if (sql.includes("b.amount::numeric AS amount")) {
    return ok(budgetRowsFor(typeof params[0] === "string" ? params[0] : undefined));
  }

  // --- single-row lookups ---
  if (sql.includes("SELECT id, name FROM departments WHERE id")) {
    const id = String(params[0]);
    return id in DEPARTMENTS ? ok([{ id, name: DEPARTMENTS[id] }]) : ok([]);
  }
  if (
    sql.includes("FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id")
  ) {
    const id = String(params[0]);
    return id in EMPLOYEES ? ok([EMP_ROWS[id]]) : ok([]);
  }

  // --- employee summaries (list + department detail) ---
  if (sql.includes("e.id, e.name, e.role, e.access_tier, d.id AS department_id")) {
    if (emptyData) return ok([]);
    const deptId = paramFor(sql, /d\.id = \$(\d+)/, params) as string | undefined;
    const rows = Object.values(EMP_ROWS).filter(
      (r) => !deptId || r.department_id === deptId,
    );
    return ok(rows);
  }

  // --- agent rows (list + employee/agent detail) ---
  // Checked before model breakdown: agentRows' SELECT also contains
  // "m.id AS model_id", so the more specific marker must win first.
  if (sql.includes("a.id, a.name, a.purpose, a.status")) {
    if (emptyData) return ok([]);
    const agentId = paramFor(sql, /a\.id = \$(\d+)/, params) as string | undefined;
    const employeeId = paramFor(sql, /a\.employee_id = \$(\d+)/, params) as
      | string
      | undefined;
    let rows = Object.values(AGENT_ROWS);
    if (agentId) rows = rows.filter((r) => r.id === agentId);
    if (employeeId) rows = rows.filter((r) => r.employee_id === employeeId);
    return ok(rows);
  }

  // --- model breakdown ---
  if (sql.includes("SELECT m.id AS model_id, m.name AS model_name")) {
    if (emptyData) return ok([]);
    return ok([
      {
        model_id: "m1",
        model_name: "gpt-4o",
        provider: "openai",
        tier: "frontier",
        cost: 30,
        tokens: 300,
      },
    ]);
  }

  // --- overview ---
  if (sql.includes("AS total_cost,")) {
    if (emptyData) {
      return ok([
        {
          total_cost: 0,
          total_tokens: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          run_count: 0,
        },
      ]);
    }
    return ok([
      {
        total_cost: 40,
        total_tokens: 400,
        total_input_tokens: 260,
        total_output_tokens: 140,
        run_count: 4,
      },
    ]);
  }
  if (sql.includes("(SELECT COUNT(*) FROM agents) AS agent_count")) {
    if (emptyData) {
      return ok([
        {
          agent_count: 0,
          active_agent_count: 0,
          employee_count: 0,
          department_count: 0,
          model_count: 0,
        },
      ]);
    }
    return ok([
      {
        agent_count: 2,
        active_agent_count: 1,
        employee_count: 2,
        department_count: 2,
        model_count: 2,
      },
    ]);
  }
  if (sql.includes("SELECT d.name AS name")) {
    return emptyData ? ok([]) : ok([{ name: "Engineering", cost: 30 }]);
  }
  if (sql.includes("SELECT m.name AS name")) {
    return emptyData ? ok([]) : ok([{ name: "gpt-4o", cost: 30 }]);
  }
  if (sql.includes(") AS total\n")) {
    return ok([{ total: emptyData ? 0 : 40 }]);
  }

  // --- departments list ---
  if (sql.includes("LEFT JOIN budgets b ON b.department_id")) {
    if (emptyData) return ok([]);
    return ok([
      {
        id: "d1",
        name: "Engineering",
        cost: 30,
        tokens: 300,
        input_tokens: 200,
        output_tokens: 100,
        month_cost: 30,
        agent_count: 1,
        employee_count: 1,
        run_count: 3,
        budget_id: 1,
        budget_amount: 100,
        period: "2026-06",
      },
      {
        id: "d2",
        name: "Sales",
        cost: 10,
        tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        month_cost: 10,
        agent_count: 1,
        employee_count: 1,
        run_count: 1,
        budget_id: null,
        budget_amount: null,
        period: "2026-06",
      },
    ]);
  }

  // --- models route (has per-million pricing in its SELECT) ---
  if (sql.includes("m.input_price_per_million, m.output_price_per_million,")) {
    if (emptyData) return ok([]);
    return ok([
      {
        id: "m1",
        name: "gpt-4o",
        provider: "openai",
        tier: "frontier",
        input_price_per_million: 5,
        output_price_per_million: 15,
        cost: 30,
        tokens: 300,
        input_tokens: 200,
        output_tokens: 100,
        agent_count: 1,
        run_count: 3,
      },
      {
        id: "m2",
        name: "claude-3",
        provider: "anthropic",
        tier: "research",
        input_price_per_million: 3,
        output_price_per_million: 10,
        cost: 10,
        tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        agent_count: 1,
        run_count: 1,
      },
    ]);
  }

  // --- tiers route ---
  if (sql.includes("access_tier AS tier, COUNT(*) AS employee_count")) {
    return ok([
      { tier: "frontier", employee_count: 1 },
      { tier: "routine", employee_count: 1 },
    ]);
  }
  if (sql.includes("LEFT JOIN agents a ON a.model_id = m.id")) {
    if (emptyData) return ok([]);
    return ok([
      {
        id: "m1",
        name: "gpt-4o",
        provider: "openai",
        tier: "frontier",
        cost: 30,
        tokens: 300,
        input_tokens: 200,
        output_tokens: 100,
        agent_count: 1,
        run_count: 3,
      },
      {
        id: "m2",
        name: "claude-3",
        provider: "anthropic",
        tier: "research",
        cost: 10,
        tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        agent_count: 1,
        run_count: 1,
      },
    ]);
  }

  // --- trends (overview + agent detail) ---
  if (sql.includes("'YYYY-MM-DD') AS date")) {
    return ok([
      { date: "2026-06-01", cost: 20, tokens: 200 },
      { date: "2026-06-02", cost: 20, tokens: 200 },
    ]);
  }

  // --- agent recent runs ---
  if (sql.includes("LIMIT 25")) {
    return ok([
      {
        id: 1001,
        timestamp: "2026-06-02T10:00:00Z",
        input_tokens: 100,
        output_tokens: 50,
        tokens: 150,
        cost: 15,
      },
    ]);
  }

  throw new Error(`Unhandled SQL in test dispatcher:\n${sql}`);
}

// Install the stub. pg's query() is heavily overloaded; cast through unknown.
(pool as unknown as { query: (text: unknown, params?: unknown) => Promise<QueryResult> }).query =
  (text: unknown, params?: unknown) => {
    const sql = typeof text === "string" ? text : String((text as { text: string }).text);
    const args = Array.isArray(params) ? (params as unknown[]) : [];
    calls.push({ sql, params: args });
    if (failNextQuery) {
      failNextQuery = false;
      return Promise.reject(new Error("simulated database failure"));
    }
    return Promise.resolve(dispatch(sql, args));
  };

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

async function sendJson<T>(
  method: string,
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as T;
  return { status: res.status, body };
}

describe("observability routes", () => {
  let server: Server;
  let base: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        base = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    calls = [];
    emptyData = false;
    failNextQuery = false;
    budgets = [{ id: 1, departmentId: "d1", modelId: null, amount: 100 }];
    nextBudgetId = 2;
  });

  // --- /overview ---
  test("GET /overview computes totals and derived fields", async () => {
    const { status, body } = await getJson<Record<string, unknown>>(`${base}/overview`);
    assert.equal(status, 200);
    assert.equal(body.totalCost, 40);
    assert.equal(body.totalTokens, 400);
    assert.equal(body.agentCount, 2);
    assert.equal(body.avgCostPerAgent, 20); // 40 / 2
    assert.equal(body.topDepartment, "Engineering");
    assert.equal(body.topModel, "gpt-4o");
  });

  test("GET /overview forwards the date range to the query", async () => {
    await getJson(`${base}/overview?from=2026-06-01&to=2026-06-30`);
    const ranged = calls.some(
      (c) => c.params.includes("2026-06-01") && c.params.includes("2026-06-30"),
    );
    assert.ok(ranged, "expected a query bound with the from/to range");
  });

  test("GET /overview handles an empty dataset", async () => {
    emptyData = true;
    const { body } = await getJson<Record<string, unknown>>(`${base}/overview`);
    assert.equal(body.totalCost, 0);
    assert.equal(body.agentCount, 0);
    assert.equal(body.avgCostPerAgent, 0);
    assert.equal(body.topDepartment, null);
    assert.equal(body.topModel, null);
  });

  test("GET /overview returns 500 when the database errors", async () => {
    failNextQuery = true;
    const res = await fetch(`${base}/overview`);
    assert.equal(res.status, 500);
  });

  // --- /overview/trends ---
  test("GET /overview/trends maps daily rows", async () => {
    const { status, body } = await getJson<Array<Record<string, number>>>(
      `${base}/overview/trends`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.deepEqual(body[0], { date: "2026-06-01", cost: 20, tokens: 200 });
  });

  // --- /departments ---
  test("GET /departments returns rows with cost share and budget", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/departments`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].name, "Engineering");
    assert.equal(body[0].costShare, 0.75); // 30 / 40
    const budget = body[0].budget as Record<string, unknown>;
    assert.equal(budget.amount, 100);
    assert.equal(budget.spend, 30);
    assert.equal(budget.status, "ok");
    assert.equal(body[1].budget, null); // Sales has no budget
  });

  test("GET /departments returns an empty array when there are none", async () => {
    emptyData = true;
    const { body } = await getJson<unknown[]>(`${base}/departments`);
    assert.deepEqual(body, []);
  });

  // --- /departments/:id ---
  test("GET /departments/:id aggregates employees and models", async () => {
    const { status, body } = await getJson<Record<string, unknown>>(
      `${base}/departments/d1`,
    );
    assert.equal(status, 200);
    assert.equal(body.name, "Engineering");
    assert.equal(body.cost, 30);
    assert.equal(body.employeeCount, 1);
    assert.equal((body.employees as unknown[]).length, 1);
    assert.equal((body.modelBreakdown as unknown[]).length, 1);
    assert.equal(body.costShare, 0.75); // 30 / 40
  });

  test("GET /departments/:id returns 404 for an unknown department", async () => {
    const { status, body } = await getJson<{ error: string }>(
      `${base}/departments/nope`,
    );
    assert.equal(status, 404);
    assert.equal(body.error, "Department not found");
  });

  // --- /employees ---
  test("GET /employees lists employee summaries", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/employees`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].name, "Alice");
    assert.equal(body[0].accessTier, "frontier");
  });

  // --- /employees/:id ---
  test("GET /employees/:id returns the employee with agents", async () => {
    const { status, body } = await getJson<Record<string, unknown>>(
      `${base}/employees/e1`,
    );
    assert.equal(status, 200);
    assert.equal(body.name, "Alice");
    assert.equal((body.agents as unknown[]).length, 1);
    assert.equal(body.cost, 30);
  });

  test("GET /employees/:id returns 404 for an unknown employee", async () => {
    const { status, body } = await getJson<{ error: string }>(`${base}/employees/nope`);
    assert.equal(status, 404);
    assert.equal(body.error, "Employee not found");
  });

  // --- /models ---
  test("GET /models returns models with cost share", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/models`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].name, "gpt-4o");
    assert.equal(body[0].inputPricePerMillion, 5);
    assert.equal(body[0].costShare, 0.75); // 30 / 40
  });

  // --- /tiers ---
  test("GET /tiers groups models by tier in order with labels", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/tiers`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    // frontier (order 0) before research (order 1)
    assert.equal(body[0].tier, "frontier");
    assert.equal(body[0].label, "Frontier");
    assert.equal(body[0].cost, 30);
    assert.equal(body[0].employeeCount, 1);
    assert.equal(body[0].modelCount, 1);
    assert.equal(body[0].costShare, 0.75);
    assert.equal(body[1].tier, "research");
    assert.equal(body[1].employeeCount, 0); // no research-tier employees
  });

  // --- /agents ---
  test("GET /agents lists all agents", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/agents`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].name, "Helper");
    assert.equal(body[0].modelName, "gpt-4o");
  });

  // --- /agents/:id ---
  test("GET /agents/:id returns the agent with trends and recent runs", async () => {
    const { status, body } = await getJson<Record<string, unknown>>(`${base}/agents/a1`);
    assert.equal(status, 200);
    assert.equal(body.name, "Helper");
    assert.equal((body.trends as unknown[]).length, 2);
    const runs = body.recentRuns as Array<Record<string, unknown>>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "1001"); // serialized as a string
    assert.equal(runs[0].cost, 15);
  });

  test("GET /agents/:id returns 404 for an unknown agent", async () => {
    const { status, body } = await getJson<{ error: string }>(`${base}/agents/nope`);
    assert.equal(status, 404);
    assert.equal(body.error, "Agent not found");
  });

  // --- /budgets ---
  test("GET /budgets returns budgets with computed utilization", async () => {
    const { status, body } = await getJson<Array<Record<string, unknown>>>(
      `${base}/budgets`,
    );
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].amount, 100);
    assert.equal(body[0].spend, 30);
    assert.equal(body[0].utilization, 0.3);
    assert.equal(body[0].status, "ok");
  });

  test("PUT /budgets validates a missing departmentId", async () => {
    const { status, body } = await sendJson<{ error: string }>("PUT", `${base}/budgets`, {
      amount: 50,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "departmentId is required");
  });

  test("PUT /budgets validates a non-positive amount", async () => {
    const { status, body } = await sendJson<{ error: string }>("PUT", `${base}/budgets`, {
      departmentId: "d1",
      amount: 0,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "amount must be a number greater than 0");
  });

  test("PUT /budgets 404s for an unknown department", async () => {
    const { status, body } = await sendJson<{ error: string }>("PUT", `${base}/budgets`, {
      departmentId: "nope",
      amount: 50,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "Department not found");
  });

  test("PUT /budgets 404s for an unknown model", async () => {
    const { status, body } = await sendJson<{ error: string }>("PUT", `${base}/budgets`, {
      departmentId: "d1",
      modelId: "nope",
      amount: 50,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "Model not found");
  });

  test("PUT /budgets updates an existing department budget", async () => {
    const { status, body } = await sendJson<Record<string, unknown>>(
      "PUT",
      `${base}/budgets`,
      { departmentId: "d1", amount: 250 },
    );
    assert.equal(status, 200);
    assert.equal(body.id, 1);
    assert.equal(body.amount, 250);
    assert.equal(budgets.find((b) => b.id === 1)?.amount, 250);
  });

  test("PUT /budgets inserts a new model-scoped budget", async () => {
    const { status, body } = await sendJson<Record<string, unknown>>(
      "PUT",
      `${base}/budgets`,
      { departmentId: "d2", modelId: "m2", amount: 75 },
    );
    assert.equal(status, 200);
    assert.equal(body.amount, 75);
    assert.equal(body.modelId, "m2");
    assert.ok(budgets.some((b) => b.departmentId === "d2" && b.modelId === "m2"));
  });

  test("PUT /budgets treats a model-scoped budget as distinct from the department-wide one", async () => {
    // d1 already has a department-wide (NULL model) budget (id 1, amount 100).
    // Adding a model-scoped budget for the same department must INSERT a new
    // row via IS NOT DISTINCT FROM, not update the NULL-model row.
    const { status, body } = await sendJson<Record<string, unknown>>(
      "PUT",
      `${base}/budgets`,
      { departmentId: "d1", modelId: "m1", amount: 40 },
    );
    assert.equal(status, 200);
    assert.equal(body.modelId, "m1");
    assert.equal(body.amount, 40);
    // The department-wide budget is untouched.
    const deptWide = budgets.find((b) => b.departmentId === "d1" && b.modelId === null);
    assert.equal(deptWide?.id, 1);
    assert.equal(deptWide?.amount, 100);
    // A separate model-scoped row now exists alongside it.
    const modelScoped = budgets.find(
      (b) => b.departmentId === "d1" && b.modelId === "m1",
    );
    assert.ok(modelScoped, "expected a new model-scoped budget row");
    assert.notEqual(modelScoped?.id, deptWide?.id);
    assert.equal(budgets.filter((b) => b.departmentId === "d1").length, 2);
  });

  test("PUT /budgets updates the department-wide budget without touching a model-scoped one", async () => {
    // Seed an existing model-scoped budget for d1 alongside the NULL-model one.
    budgets.push({ id: 5, departmentId: "d1", modelId: "m1", amount: 40 });
    nextBudgetId = 6;
    const { status, body } = await sendJson<Record<string, unknown>>(
      "PUT",
      `${base}/budgets`,
      { departmentId: "d1", amount: 250 },
    );
    assert.equal(status, 200);
    // The NULL-model row (id 1) is updated, not the model-scoped one.
    assert.equal(body.id, 1);
    assert.equal(body.amount, 250);
    assert.equal(body.modelId, null);
    const modelScoped = budgets.find((b) => b.id === 5);
    assert.equal(modelScoped?.amount, 40, "model-scoped budget must be untouched");
    // No new row was inserted; still two budgets for d1.
    assert.equal(budgets.filter((b) => b.departmentId === "d1").length, 2);
  });

  // --- DELETE /budgets/:id ---
  test("DELETE /budgets/:id removes an existing budget", async () => {
    const res = await fetch(`${base}/budgets/1`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(budgets.length, 0);
  });

  test("DELETE /budgets/:id 404s for a non-numeric id", async () => {
    const res = await fetch(`${base}/budgets/abc`, { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  test("DELETE /budgets/:id 404s for a missing budget", async () => {
    const res = await fetch(`${base}/budgets/999`, { method: "DELETE" });
    assert.equal(res.status, 404);
  });
});
