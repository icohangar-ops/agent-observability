import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// Cost expression in USD computed from tokens and per-model pricing.
// input_price/output_price are stored per 1,000,000 tokens.
const COST_SQL = `(u.input_tokens::numeric / 1000000 * m.input_price_per_million
  + u.output_tokens::numeric / 1000000 * m.output_price_per_million)`;

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

const TIER_LABELS: Record<string, string> = {
  frontier: "Frontier",
  research: "Research",
  routine: "Routine",
};

const TIER_ORDER: Record<string, number> = {
  frontier: 0,
  research: 1,
  routine: 2,
};

interface DateRange {
  from: string | null;
  to: string | null;
}

// Parse optional `from`/`to` ISO date (YYYY-MM-DD) query params.
function parseRange(query: Record<string, unknown>): DateRange {
  const from =
    typeof query.from === "string" && query.from.trim() !== "" ? query.from.trim() : null;
  const to =
    typeof query.to === "string" && query.to.trim() !== "" ? query.to.trim() : null;
  return { from, to };
}

// Build SQL conditions constraining a usage_events alias to the date range.
// Pushes bound params onto `params` and returns the condition fragments so the
// caller can place them in a WHERE clause or a LEFT JOIN ... ON clause.
// `to` is treated as an inclusive day (events on that calendar day are kept).
function rangeConds(alias: string, range: DateRange, params: unknown[]): string[] {
  const conds: string[] = [];
  if (range.from) {
    params.push(range.from);
    conds.push(`${alias}.timestamp >= $${params.length}::date`);
  }
  if (range.to) {
    params.push(range.to);
    conds.push(`${alias}.timestamp < ($${params.length}::date + interval '1 day')`);
  }
  return conds;
}

// Fraction of budget at/above which a department is flagged "near budget".
const NEAR_BUDGET_THRESHOLD = 0.8;

export function budgetStatus(spend: number, amount: number): "ok" | "warning" | "over" {
  if (amount <= 0) return "ok";
  const utilization = spend / amount;
  if (utilization >= 1) return "over";
  if (utilization >= NEAR_BUDGET_THRESHOLD) return "warning";
  return "ok";
}

// Current calendar month label (YYYY-MM) for the spend window budgets compare against.
const CURRENT_PERIOD_SQL = `to_char(date_trunc('month', now()), 'YYYY-MM')`;
// Predicate restricting usage_events to the current calendar month.
const CURRENT_MONTH_FILTER = `u.timestamp >= date_trunc('month', now())
  AND u.timestamp < date_trunc('month', now()) + interval '1 month'`;

router.get("/overview", async (req, res) => {
  const range = parseRange(req.query);
  const totalsParams: unknown[] = [];
  const totalsWhere = rangeConds("u", range, totalsParams);
  const totalsQ = await pool.query(
    `
    SELECT
      COALESCE(SUM(${COST_SQL}), 0) AS total_cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS total_tokens,
      COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
      COUNT(u.id) AS run_count
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    ${totalsWhere.length ? `WHERE ${totalsWhere.join(" AND ")}` : ""}
  `,
    totalsParams,
  );

  const countsQ = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agent_count,
      (SELECT COUNT(*) FROM agents WHERE status = 'active') AS active_agent_count,
      (SELECT COUNT(*) FROM employees) AS employee_count,
      (SELECT COUNT(*) FROM departments) AS department_count,
      (SELECT COUNT(*) FROM models) AS model_count
  `);

  const topDeptParams: unknown[] = [];
  const topDeptWhere = rangeConds("u", range, topDeptParams);
  const topDeptQ = await pool.query(
    `
    SELECT d.name AS name, SUM(${COST_SQL}) AS cost
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    JOIN employees e ON e.id = a.employee_id
    JOIN departments d ON d.id = e.department_id
    ${topDeptWhere.length ? `WHERE ${topDeptWhere.join(" AND ")}` : ""}
    GROUP BY d.name ORDER BY cost DESC LIMIT 1
  `,
    topDeptParams,
  );

  const topModelParams: unknown[] = [];
  const topModelWhere = rangeConds("u", range, topModelParams);
  const topModelQ = await pool.query(
    `
    SELECT m.name AS name, SUM(${COST_SQL}) AS cost
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    ${topModelWhere.length ? `WHERE ${topModelWhere.join(" AND ")}` : ""}
    GROUP BY m.name ORDER BY cost DESC LIMIT 1
  `,
    topModelParams,
  );

  const t = totalsQ.rows[0];
  const c = countsQ.rows[0];
  const agentCount = num(c.agent_count);
  const totalCost = num(t.total_cost);

  res.json({
    totalCost,
    totalTokens: num(t.total_tokens),
    totalInputTokens: num(t.total_input_tokens),
    totalOutputTokens: num(t.total_output_tokens),
    agentCount,
    activeAgentCount: num(c.active_agent_count),
    employeeCount: num(c.employee_count),
    departmentCount: num(c.department_count),
    modelCount: num(c.model_count),
    runCount: num(t.run_count),
    avgCostPerAgent: agentCount > 0 ? totalCost / agentCount : 0,
    topDepartment: topDeptQ.rows[0]?.name ?? null,
    topModel: topModelQ.rows[0]?.name ?? null,
  });
});

router.get("/overview/trends", async (req, res) => {
  const range = parseRange(req.query);
  const params: unknown[] = [];
  const where = rangeConds("u", range, params);
  const q = await pool.query(
    `
    SELECT
      to_char(date_trunc('day', u.timestamp), 'YYYY-MM-DD') AS date,
      SUM(${COST_SQL}) AS cost,
      SUM(u.input_tokens + u.output_tokens) AS tokens
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY 1 ORDER BY 1 ASC
  `,
    params,
  );
  res.json(
    q.rows.map((r) => ({
      date: r.date,
      cost: num(r.cost),
      tokens: num(r.tokens),
    })),
  );
});

router.get("/departments", async (req, res) => {
  const range = parseRange(req.query);
  const params: unknown[] = [];
  const usageConds = rangeConds("u", range, params);
  const usageJoin = `LEFT JOIN usage_events u ON u.agent_id = a.id${
    usageConds.length ? ` AND ${usageConds.join(" AND ")}` : ""
  }`;
  const q = await pool.query(
    `
    SELECT
      d.id, d.name,
      COALESCE(SUM(${COST_SQL}), 0) AS cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
      COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${COST_SQL}) FILTER (WHERE ${CURRENT_MONTH_FILTER}), 0) AS month_cost,
      COUNT(DISTINCT a.id) AS agent_count,
      COUNT(DISTINCT e.id) AS employee_count,
      COUNT(u.id) AS run_count,
      b.id AS budget_id,
      b.amount::numeric AS budget_amount,
      ${CURRENT_PERIOD_SQL} AS period
    FROM departments d
    LEFT JOIN employees e ON e.department_id = d.id
    LEFT JOIN agents a ON a.employee_id = e.id
    LEFT JOIN models m ON m.id = a.model_id
    ${usageJoin}
    LEFT JOIN budgets b ON b.department_id = d.id AND b.model_id IS NULL
    GROUP BY d.id, d.name, b.id, b.amount
    ORDER BY cost DESC
  `,
    params,
  );
  const total = q.rows.reduce((s, r) => s + num(r.cost), 0);
  res.json(
    q.rows.map((r) => {
      const monthCost = num(r.month_cost);
      const budgetAmount = r.budget_amount === null ? null : num(r.budget_amount);
      return {
        id: r.id,
        name: r.name,
        cost: num(r.cost),
        tokens: num(r.tokens),
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        agentCount: num(r.agent_count),
        employeeCount: num(r.employee_count),
        runCount: num(r.run_count),
        costShare: total > 0 ? num(r.cost) / total : 0,
        budget:
          budgetAmount === null
            ? null
            : {
                id: num(r.budget_id),
                amount: budgetAmount,
                spend: monthCost,
                utilization: budgetAmount > 0 ? monthCost / budgetAmount : 0,
                status: budgetStatus(monthCost, budgetAmount),
                period: r.period,
              },
      };
    }),
  );
});

async function employeeSummaries(whereDept?: string, range?: DateRange) {
  const params: unknown[] = [];
  let where = "";
  if (whereDept) {
    params.push(whereDept);
    where = `WHERE d.id = $${params.length}`;
  }
  const usageConds = range ? rangeConds("u", range, params) : [];
  const usageJoin = `LEFT JOIN usage_events u ON u.agent_id = a.id${
    usageConds.length ? ` AND ${usageConds.join(" AND ")}` : ""
  }`;
  const q = await pool.query(
    `
    SELECT
      e.id, e.name, e.role, e.access_tier, d.id AS department_id, d.name AS department_name,
      COALESCE(SUM(${COST_SQL}), 0) AS cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
      COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
      COUNT(DISTINCT a.id) AS agent_count,
      COUNT(u.id) AS run_count
    FROM employees e
    JOIN departments d ON d.id = e.department_id
    LEFT JOIN agents a ON a.employee_id = e.id
    LEFT JOIN models m ON m.id = a.model_id
    ${usageJoin}
    ${where}
    GROUP BY e.id, e.name, e.role, e.access_tier, d.id, d.name
    ORDER BY cost DESC
  `,
    params,
  );
  return q.rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    accessTier: r.access_tier,
    departmentId: r.department_id,
    departmentName: r.department_name,
    cost: num(r.cost),
    tokens: num(r.tokens),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    agentCount: num(r.agent_count),
    runCount: num(r.run_count),
  }));
}

async function modelBreakdown(opts: {
  departmentId?: string;
  employeeId?: string;
  range?: DateRange;
}) {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (opts.departmentId) {
    params.push(opts.departmentId);
    conds.push(`e.department_id = $${params.length}`);
  }
  if (opts.employeeId) {
    params.push(opts.employeeId);
    conds.push(`a.employee_id = $${params.length}`);
  }
  if (opts.range) {
    conds.push(...rangeConds("u", opts.range, params));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const q = await pool.query(
    `
    SELECT m.id AS model_id, m.name AS model_name, m.provider, m.tier,
      COALESCE(SUM(${COST_SQL}), 0) AS cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN employees e ON e.id = a.employee_id
    JOIN models m ON m.id = a.model_id
    ${where}
    GROUP BY m.id, m.name, m.provider, m.tier
    ORDER BY cost DESC
  `,
    params,
  );
  return q.rows.map((r) => ({
    modelId: r.model_id,
    modelName: r.model_name,
    provider: r.provider,
    tier: r.tier,
    cost: num(r.cost),
    tokens: num(r.tokens),
  }));
}

router.get("/departments/:departmentId", async (req, res) => {
  const { departmentId } = req.params;
  const range = parseRange(req.query);
  const deptQ = await pool.query(`SELECT id, name FROM departments WHERE id = $1`, [
    departmentId,
  ]);
  if (deptQ.rows.length === 0) {
    res.status(404).json({ error: "Department not found" });
    return;
  }
  const employees = await employeeSummaries(departmentId, range);
  const models = await modelBreakdown({ departmentId, range });

  const cost = employees.reduce((s, e) => s + e.cost, 0);
  const tokens = employees.reduce((s, e) => s + e.tokens, 0);
  const inputTokens = employees.reduce((s, e) => s + e.inputTokens, 0);
  const outputTokens = employees.reduce((s, e) => s + e.outputTokens, 0);
  const agentCount = employees.reduce((s, e) => s + e.agentCount, 0);
  const runCount = employees.reduce((s, e) => s + e.runCount, 0);

  const totalParams: unknown[] = [];
  const totalWhere = rangeConds("u", range, totalParams);
  const totalQ = await pool.query(
    `
    SELECT COALESCE(SUM(${COST_SQL}), 0) AS total
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    ${totalWhere.length ? `WHERE ${totalWhere.join(" AND ")}` : ""}
  `,
    totalParams,
  );
  const total = num(totalQ.rows[0].total);

  const allBudgets = await budgetRows(departmentId);
  const deptBudget = allBudgets.find((b) => b.modelId === null) ?? null;
  const modelBudgets = allBudgets.filter((b) => b.modelId !== null);

  res.json({
    id: deptQ.rows[0].id,
    name: deptQ.rows[0].name,
    cost,
    tokens,
    inputTokens,
    outputTokens,
    agentCount,
    employeeCount: employees.length,
    runCount,
    costShare: total > 0 ? cost / total : 0,
    employees,
    modelBreakdown: models,
    budget: deptBudget
      ? {
          id: deptBudget.id,
          amount: deptBudget.amount,
          spend: deptBudget.spend,
          utilization: deptBudget.utilization,
          status: deptBudget.status,
          period: deptBudget.period,
        }
      : null,
    modelBudgets,
  });
});

router.get("/employees", async (req, res) => {
  res.json(await employeeSummaries(undefined, parseRange(req.query)));
});

async function agentRows(opts: {
  employeeId?: string;
  agentId?: string;
  range?: DateRange;
}) {
  const params: unknown[] = [];
  const aggConds = opts.range ? rangeConds("u", opts.range, params) : [];
  const aggWhere = aggConds.length ? `WHERE ${aggConds.join(" AND ")}` : "";
  const conds: string[] = [];
  if (opts.employeeId) {
    params.push(opts.employeeId);
    conds.push(`a.employee_id = $${params.length}`);
  }
  if (opts.agentId) {
    params.push(opts.agentId);
    conds.push(`a.id = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const q = await pool.query(
    `
    SELECT
      a.id, a.name, a.purpose, a.status,
      e.id AS employee_id, e.name AS employee_name,
      d.id AS department_id, d.name AS department_name,
      m.id AS model_id, m.name AS model_name, m.provider, m.tier AS model_tier,
      to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
      to_char(a.last_active_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_active_at,
      COALESCE(agg.cost, 0) AS cost,
      COALESCE(agg.tokens, 0) AS tokens,
      COALESCE(agg.input_tokens, 0) AS input_tokens,
      COALESCE(agg.output_tokens, 0) AS output_tokens,
      COALESCE(agg.run_count, 0) AS run_count
    FROM agents a
    JOIN employees e ON e.id = a.employee_id
    JOIN departments d ON d.id = e.department_id
    JOIN models m ON m.id = a.model_id
    LEFT JOIN (
      SELECT u.agent_id,
        SUM(u.input_tokens::numeric / 1000000 * mm.input_price_per_million
          + u.output_tokens::numeric / 1000000 * mm.output_price_per_million) AS cost,
        SUM(u.input_tokens + u.output_tokens) AS tokens,
        SUM(u.input_tokens) AS input_tokens,
        SUM(u.output_tokens) AS output_tokens,
        COUNT(u.id) AS run_count
      FROM usage_events u
      JOIN agents aa ON aa.id = u.agent_id
      JOIN models mm ON mm.id = aa.model_id
      ${aggWhere}
      GROUP BY u.agent_id
    ) agg ON agg.agent_id = a.id
    ${where}
    ORDER BY cost DESC
  `,
    params,
  );
  return q.rows.map((r) => ({
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    status: r.status,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    modelId: r.model_id,
    modelName: r.model_name,
    provider: r.provider,
    modelTier: r.model_tier,
    cost: num(r.cost),
    tokens: num(r.tokens),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    runCount: num(r.run_count),
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }));
}

router.get("/employees/:employeeId", async (req, res) => {
  const { employeeId } = req.params;
  const range = parseRange(req.query);
  const empQ = await pool.query(
    `SELECT e.id, e.name, e.role, e.access_tier, d.id AS department_id, d.name AS department_name
     FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1`,
    [employeeId],
  );
  if (empQ.rows.length === 0) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const agents = await agentRows({ employeeId, range });
  const models = await modelBreakdown({ employeeId, range });

  const cost = agents.reduce((s, a) => s + a.cost, 0);
  const tokens = agents.reduce((s, a) => s + a.tokens, 0);
  const inputTokens = agents.reduce((s, a) => s + a.inputTokens, 0);
  const outputTokens = agents.reduce((s, a) => s + a.outputTokens, 0);
  const runCount = agents.reduce((s, a) => s + a.runCount, 0);
  const e = empQ.rows[0];

  res.json({
    id: e.id,
    name: e.name,
    role: e.role,
    accessTier: e.access_tier,
    departmentId: e.department_id,
    departmentName: e.department_name,
    cost,
    tokens,
    inputTokens,
    outputTokens,
    agentCount: agents.length,
    runCount,
    agents,
    modelBreakdown: models,
  });
});

router.get("/models", async (req, res) => {
  const range = parseRange(req.query);
  const params: unknown[] = [];
  const usageConds = rangeConds("u", range, params);
  const usageJoin = `LEFT JOIN usage_events u ON u.agent_id = a.id${
    usageConds.length ? ` AND ${usageConds.join(" AND ")}` : ""
  }`;
  const q = await pool.query(
    `
    SELECT m.id, m.name, m.provider, m.tier,
      m.input_price_per_million, m.output_price_per_million,
      COALESCE(SUM(${COST_SQL}), 0) AS cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
      COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
      COUNT(DISTINCT a.id) AS agent_count,
      COUNT(u.id) AS run_count
    FROM models m
    LEFT JOIN agents a ON a.model_id = m.id
    ${usageJoin}
    GROUP BY m.id, m.name, m.provider, m.tier, m.input_price_per_million, m.output_price_per_million
    ORDER BY cost DESC
  `,
    params,
  );
  const total = q.rows.reduce((s, r) => s + num(r.cost), 0);
  res.json(
    q.rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      tier: r.tier,
      inputPricePerMillion: num(r.input_price_per_million),
      outputPricePerMillion: num(r.output_price_per_million),
      cost: num(r.cost),
      tokens: num(r.tokens),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      agentCount: num(r.agent_count),
      runCount: num(r.run_count),
      costShare: total > 0 ? num(r.cost) / total : 0,
    })),
  );
});

router.get("/tiers", async (req, res) => {
  const range = parseRange(req.query);
  const params: unknown[] = [];
  const usageConds = rangeConds("u", range, params);
  const usageJoin = `LEFT JOIN usage_events u ON u.agent_id = a.id${
    usageConds.length ? ` AND ${usageConds.join(" AND ")}` : ""
  }`;
  const modelsQ = await pool.query(
    `
    SELECT m.id, m.name, m.provider, m.tier,
      COALESCE(SUM(${COST_SQL}), 0) AS cost,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens,
      COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
      COUNT(DISTINCT a.id) AS agent_count,
      COUNT(u.id) AS run_count
    FROM models m
    LEFT JOIN agents a ON a.model_id = m.id
    ${usageJoin}
    GROUP BY m.id, m.name, m.provider, m.tier
    ORDER BY cost DESC
  `,
    params,
  );

  const empQ = await pool.query(`
    SELECT access_tier AS tier, COUNT(*) AS employee_count
    FROM employees GROUP BY access_tier
  `);
  const employeeByTier = new Map<string, number>();
  for (const r of empQ.rows) employeeByTier.set(r.tier, num(r.employee_count));

  type TierAgg = {
    tier: string;
    cost: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    agentCount: number;
    runCount: number;
    models: Array<{
      modelId: string;
      modelName: string;
      provider: string;
      tier: string;
      cost: number;
      tokens: number;
    }>;
  };
  const tiers = new Map<string, TierAgg>();
  let total = 0;
  for (const r of modelsQ.rows) {
    const tier = r.tier as string;
    const cost = num(r.cost);
    total += cost;
    let t = tiers.get(tier);
    if (!t) {
      t = {
        tier,
        cost: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        agentCount: 0,
        runCount: 0,
        models: [],
      };
      tiers.set(tier, t);
    }
    t.cost += cost;
    t.tokens += num(r.tokens);
    t.inputTokens += num(r.input_tokens);
    t.outputTokens += num(r.output_tokens);
    t.agentCount += num(r.agent_count);
    t.runCount += num(r.run_count);
    t.models.push({
      modelId: r.id,
      modelName: r.name,
      provider: r.provider,
      tier,
      cost,
      tokens: num(r.tokens),
    });
  }

  const result = Array.from(tiers.values())
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99))
    .map((t) => ({
      tier: t.tier,
      label: TIER_LABELS[t.tier] ?? t.tier,
      cost: t.cost,
      tokens: t.tokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costShare: total > 0 ? t.cost / total : 0,
      agentCount: t.agentCount,
      employeeCount: employeeByTier.get(t.tier) ?? 0,
      modelCount: t.models.length,
      runCount: t.runCount,
      models: t.models,
    }));

  res.json(result);
});

router.get("/agents", async (req, res) => {
  res.json(await agentRows({ range: parseRange(req.query) }));
});

router.get("/agents/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const range = parseRange(req.query);
  const rows = await agentRows({ agentId, range });
  if (rows.length === 0) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const agent = rows[0];

  const trendsParams: unknown[] = [agentId];
  const trendsConds = ["u.agent_id = $1", ...rangeConds("u", range, trendsParams)];
  const trendsQ = await pool.query(
    `
    SELECT to_char(date_trunc('day', u.timestamp), 'YYYY-MM-DD') AS date,
      SUM(${COST_SQL}) AS cost,
      SUM(u.input_tokens + u.output_tokens) AS tokens
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    WHERE ${trendsConds.join(" AND ")}
    GROUP BY 1 ORDER BY 1 ASC
  `,
    trendsParams,
  );

  const runsParams: unknown[] = [agentId];
  const runsConds = ["u.agent_id = $1", ...rangeConds("u", range, runsParams)];
  const runsQ = await pool.query(
    `
    SELECT u.id,
      to_char(u.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
      u.input_tokens, u.output_tokens,
      (u.input_tokens + u.output_tokens) AS tokens,
      ${COST_SQL} AS cost
    FROM usage_events u
    JOIN agents a ON a.id = u.agent_id
    JOIN models m ON m.id = a.model_id
    WHERE ${runsConds.join(" AND ")}
    ORDER BY u.timestamp DESC
    LIMIT 25
  `,
    runsParams,
  );

  res.json({
    ...agent,
    trends: trendsQ.rows.map((r) => ({
      date: r.date,
      cost: num(r.cost),
      tokens: num(r.tokens),
    })),
    recentRuns: runsQ.rows.map((r) => ({
      id: String(r.id),
      timestamp: r.timestamp,
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      tokens: num(r.tokens),
      cost: num(r.cost),
    })),
  });
});

type BudgetRow = {
  id: number;
  departmentId: string;
  departmentName: string;
  modelId: string | null;
  modelName: string | null;
  amount: number;
  spend: number;
  utilization: number;
  status: "ok" | "warning" | "over";
  period: string;
};

// Fetch budgets (optionally for a single department) with current-month spend.
async function budgetRows(departmentId?: string): Promise<BudgetRow[]> {
  const params: string[] = [];
  let where = "";
  if (departmentId) {
    params.push(departmentId);
    where = `WHERE b.department_id = $1`;
  }
  const q = await pool.query(
    `
    SELECT
      b.id,
      b.department_id,
      d.name AS department_name,
      b.model_id,
      m.name AS model_name,
      b.amount::numeric AS amount,
      ${CURRENT_PERIOD_SQL} AS period,
      COALESCE((
        SELECT SUM(u.input_tokens::numeric / 1000000 * mm.input_price_per_million
          + u.output_tokens::numeric / 1000000 * mm.output_price_per_million)
        FROM usage_events u
        JOIN agents a ON a.id = u.agent_id
        JOIN employees e ON e.id = a.employee_id
        JOIN models mm ON mm.id = a.model_id
        WHERE e.department_id = b.department_id
          AND (b.model_id IS NULL OR a.model_id = b.model_id)
          AND ${CURRENT_MONTH_FILTER}
      ), 0) AS spend
    FROM budgets b
    JOIN departments d ON d.id = b.department_id
    LEFT JOIN models m ON m.id = b.model_id
    ${where}
    ORDER BY d.name ASC, m.name ASC NULLS FIRST
  `,
    params,
  );
  return q.rows.map((r) => {
    const amount = num(r.amount);
    const spend = num(r.spend);
    return {
      id: num(r.id),
      departmentId: r.department_id,
      departmentName: r.department_name,
      modelId: r.model_id,
      modelName: r.model_name,
      amount,
      spend,
      utilization: amount > 0 ? spend / amount : 0,
      status: budgetStatus(spend, amount),
      period: r.period,
    };
  });
}

router.get("/budgets", async (_req, res) => {
  res.json(await budgetRows());
});

router.put("/budgets", async (req, res) => {
  const body = (req.body ?? {}) as {
    departmentId?: unknown;
    modelId?: unknown;
    amount?: unknown;
  };
  const departmentId =
    typeof body.departmentId === "string" ? body.departmentId.trim() : "";
  const modelId =
    body.modelId === null || body.modelId === undefined || body.modelId === ""
      ? null
      : typeof body.modelId === "string"
        ? body.modelId.trim()
        : null;
  const amount = Number(body.amount);

  if (!departmentId) {
    res.status(400).json({ error: "departmentId is required" });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a number greater than 0" });
    return;
  }

  const deptQ = await pool.query(`SELECT id FROM departments WHERE id = $1`, [
    departmentId,
  ]);
  if (deptQ.rows.length === 0) {
    res.status(404).json({ error: "Department not found" });
    return;
  }
  if (modelId !== null) {
    const modelQ = await pool.query(`SELECT id FROM models WHERE id = $1`, [modelId]);
    if (modelQ.rows.length === 0) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
  }

  // Upsert: NULL model_id rows are not handled by ON CONFLICT (NULLs distinct),
  // so match the existing row explicitly using IS NOT DISTINCT FROM.
  const existing = await pool.query(
    `SELECT id FROM budgets
     WHERE department_id = $1 AND model_id IS NOT DISTINCT FROM $2`,
    [departmentId, modelId],
  );
  let budgetId: number;
  if (existing.rows.length > 0) {
    budgetId = existing.rows[0].id;
    await pool.query(
      `UPDATE budgets SET amount = $1, updated_at = now() WHERE id = $2`,
      [amount, budgetId],
    );
  } else {
    const inserted = await pool.query(
      `INSERT INTO budgets (department_id, model_id, amount)
       VALUES ($1, $2, $3) RETURNING id`,
      [departmentId, modelId, amount],
    );
    budgetId = inserted.rows[0].id;
  }

  const rows = await budgetRows(departmentId);
  const saved = rows.find((b) => b.id === budgetId);
  res.json(saved);
});

router.delete("/budgets/:budgetId", async (req, res) => {
  const budgetId = Number(req.params.budgetId);
  if (!Number.isInteger(budgetId)) {
    res.status(404).json({ error: "Budget not found" });
    return;
  }
  const result = await pool.query(`DELETE FROM budgets WHERE id = $1`, [budgetId]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Budget not found" });
    return;
  }
  res.status(204).send();
});

export default router;
