import {
  db,
  pool,
  departmentsTable,
  modelsTable,
  employeesTable,
  agentsTable,
  usageEventsTable,
} from "@workspace/db";

// Deterministic RNG so the dataset is stable across reseeds.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260623);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

const departments = [
  { id: "dept-eng", name: "Engineering" },
  { id: "dept-sales", name: "Sales" },
  { id: "dept-marketing", name: "Marketing" },
  { id: "dept-support", name: "Customer Support" },
  { id: "dept-finance", name: "Finance" },
  { id: "dept-product", name: "Product" },
  { id: "dept-ops", name: "Operations" },
  { id: "dept-legal", name: "Legal" },
];

// Tiers, ordered by access level / cost. A higher rank grants access to all
// models at or below it.
const tierRank: Record<string, number> = {
  routine: 1,
  research: 2,
  frontier: 3,
};

const models = [
  // Frontier — premium models for complex analysis
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    tier: "frontier",
    inputPricePerMillion: "2.5000",
    outputPricePerMillion: "10.0000",
    weight: 4,
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "Anthropic",
    tier: "frontier",
    inputPricePerMillion: "3.0000",
    outputPricePerMillion: "15.0000",
    weight: 5,
  },
  // Research — web-grounded / research models
  {
    id: "perplexity-sonar-large",
    name: "Perplexity Sonar Large",
    provider: "Perplexity",
    tier: "research",
    inputPricePerMillion: "1.0000",
    outputPricePerMillion: "1.0000",
    weight: 4,
  },
  {
    id: "gemini-1-5-pro",
    name: "Gemini 1.5 Pro",
    provider: "Google",
    tier: "research",
    inputPricePerMillion: "1.2500",
    outputPricePerMillion: "5.0000",
    weight: 3,
  },
  // Routine — cost-optimized models and routers for everyday work
  {
    id: "openrouter-auto",
    name: "OpenRouter (Auto Router)",
    provider: "OpenRouter",
    tier: "routine",
    inputPricePerMillion: "0.3000",
    outputPricePerMillion: "0.6000",
    weight: 5,
  },
  {
    id: "baseten-router",
    name: "Baseten Model Router",
    provider: "Baseten",
    tier: "routine",
    inputPricePerMillion: "0.2000",
    outputPricePerMillion: "0.4000",
    weight: 3,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "OpenAI",
    tier: "routine",
    inputPricePerMillion: "0.1500",
    outputPricePerMillion: "0.6000",
    weight: 5,
  },
  {
    id: "claude-3-haiku",
    name: "Claude 3 Haiku",
    provider: "Anthropic",
    tier: "routine",
    inputPricePerMillion: "0.2500",
    outputPricePerMillion: "1.2500",
    weight: 3,
  },
  {
    id: "llama-3-1-70b",
    name: "Llama 3.1 70B",
    provider: "Meta",
    tier: "routine",
    inputPricePerMillion: "0.5000",
    outputPricePerMillion: "0.7500",
    weight: 3,
  },
];

function pickModelForTier(accessTier: string): string {
  // Build an allowed pool of every model at or below the access tier. Higher
  // tiers still lean on their own premium models, so bias toward the top tier.
  const maxRank = tierRank[accessTier];
  const pool: string[] = [];
  for (const m of models) {
    if (tierRank[m.tier] <= maxRank) {
      // models that match the employee's own tier get extra weight
      const bias = m.tier === accessTier ? 2 : 1;
      for (let i = 0; i < m.weight * bias; i++) pool.push(m.id);
    }
  }
  return pool[Math.floor(rand() * pool.length)];
}

const firstNames = [
  "Ava", "Liam", "Maya", "Noah", "Sofia", "Ethan", "Isla", "Lucas",
  "Priya", "Omar", "Chloe", "Mateo", "Hana", "Daniel", "Zoe", "Ravi",
  "Elena", "Marcus", "Nina", "Ibrahim", "Grace", "Theo", "Lena", "Jamal",
  "Wei", "Aisha", "Diego", "Freya", "Kenji", "Camila",
];

const lastNames = [
  "Patel", "Nguyen", "Garcia", "Khan", "Rossi", "Müller", "Silva", "Cohen",
  "Okafor", "Tanaka", "Ahmed", "Brooks", "Lindqvist", "Reyes", "Novak",
  "Haddad", "Costa", "Ivanov", "Park", "Mensah", "Lopez", "Schneider",
  "Bianchi", "Fischer",
];

const rolesByDept: Record<string, string[]> = {
  "dept-eng": ["Software Engineer", "Staff Engineer", "Engineering Manager", "DevOps Engineer", "QA Engineer"],
  "dept-sales": ["Account Executive", "Sales Development Rep", "Sales Manager", "Solutions Engineer"],
  "dept-marketing": ["Content Strategist", "Growth Marketer", "Brand Manager", "SEO Specialist"],
  "dept-support": ["Support Specialist", "Support Lead", "Customer Success Manager"],
  "dept-finance": ["Financial Analyst", "Controller", "FP&A Analyst", "Accountant"],
  "dept-product": ["Product Manager", "Product Designer", "Data Analyst", "UX Researcher"],
  "dept-ops": ["Operations Analyst", "Program Manager", "Procurement Specialist"],
  "dept-legal": ["Legal Counsel", "Contracts Manager", "Compliance Analyst"],
};

const agentTemplatesByDept: Record<string, string[]> = {
  "dept-eng": ["Code Review Assistant", "Incident Triage Bot", "Test Generator", "Docs Writer", "PR Summarizer", "Log Analyzer"],
  "dept-sales": ["Lead Qualifier", "Email Outreach Agent", "Call Summarizer", "Proposal Drafter", "CRM Enricher"],
  "dept-marketing": ["Content Generator", "SEO Optimizer", "Social Scheduler", "Campaign Analyzer", "Ad Copywriter"],
  "dept-support": ["Ticket Classifier", "Response Drafter", "Knowledge Base Bot", "Escalation Router", "Sentiment Monitor"],
  "dept-finance": ["Invoice Reconciler", "Expense Auditor", "Forecast Modeler", "Spend Analyzer", "Report Compiler"],
  "dept-product": ["Feedback Synthesizer", "Roadmap Assistant", "User Interview Analyzer", "Metrics Narrator"],
  "dept-ops": ["Vendor Researcher", "Process Auditor", "Scheduling Agent", "Inventory Forecaster"],
  "dept-legal": ["Contract Reviewer", "Clause Extractor", "Compliance Checker", "NDA Drafter"],
};

const purposeSuffix = [
  "to cut manual review time",
  "for the daily operations workflow",
  "to support the team's weekly cadence",
  "across the customer lifecycle",
  "for quarterly reporting",
  "to accelerate response times",
  "for cross-functional handoffs",
  "to reduce repetitive workload",
];

const statuses = ["active", "active", "active", "idle", "idle", "archived"];

// Default access tier granted to each department, reflecting the kind of work
// they do. Individual employees may occasionally be upgraded a tier.
const departmentAccessTier: Record<string, string> = {
  "dept-finance": "frontier", // complex analysis
  "dept-product": "frontier", // complex analysis
  "dept-legal": "frontier", // complex analysis
  "dept-eng": "research", // research + build
  "dept-marketing": "research", // research-heavy content
  "dept-support": "routine", // routine, high volume
  "dept-sales": "routine", // routine outreach
  "dept-ops": "routine", // routine operations
};

const tierUpgradePath: Record<string, string> = {
  routine: "research",
  research: "frontier",
  frontier: "frontier",
};

async function main() {
  console.log("Clearing existing data...");
  await db.delete(usageEventsTable);
  await db.delete(agentsTable);
  await db.delete(employeesTable);
  await db.delete(modelsTable);
  await db.delete(departmentsTable);

  console.log("Inserting departments and models...");
  await db.insert(departmentsTable).values(departments);
  await db.insert(modelsTable).values(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      tier: m.tier,
      inputPricePerMillion: m.inputPricePerMillion,
      outputPricePerMillion: m.outputPricePerMillion,
    })),
  );

  // Employees
  const employees: {
    id: string;
    name: string;
    role: string;
    accessTier: string;
    departmentId: string;
  }[] = [];
  let empCounter = 0;
  for (const dept of departments) {
    const count = randInt(3, 5);
    for (let i = 0; i < count; i++) {
      empCounter++;
      const name = `${pick(firstNames)} ${pick(lastNames)}`;
      const baseTier = departmentAccessTier[dept.id];
      // ~20% of employees are granted one tier above their department default.
      const accessTier =
        rand() < 0.2 ? tierUpgradePath[baseTier] : baseTier;
      employees.push({
        id: `emp-${empCounter}`,
        name,
        role: pick(rolesByDept[dept.id]),
        accessTier,
        departmentId: dept.id,
      });
    }
  }
  console.log(`Inserting ${employees.length} employees...`);
  await db.insert(employeesTable).values(employees);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const HISTORY_DAYS = 30;

  // Agents
  const agents: {
    id: string;
    name: string;
    purpose: string;
    status: string;
    employeeId: string;
    modelId: string;
    createdAt: Date;
    lastActiveAt: Date;
  }[] = [];
  let agentCounter = 0;
  for (const emp of employees) {
    const count = randInt(1, 4);
    const templates = agentTemplatesByDept[emp.departmentId];
    for (let i = 0; i < count; i++) {
      agentCounter++;
      const baseName = pick(templates);
      const status = pick(statuses);
      const createdDaysAgo = randInt(10, 120);
      const createdAt = new Date(now - createdDaysAgo * DAY);
      agents.push({
        id: `agent-${agentCounter}`,
        name: `${baseName}`,
        purpose: `${baseName} ${pick(purposeSuffix)}`,
        status,
        employeeId: emp.id,
        modelId: pickModelForTier(emp.accessTier),
        createdAt,
        lastActiveAt: createdAt, // updated below from usage
      });
    }
  }

  // Usage events
  const usageEvents: {
    agentId: string;
    timestamp: Date;
    inputTokens: number;
    outputTokens: number;
  }[] = [];

  for (const agent of agents) {
    // Archived agents stopped producing usage a while ago.
    const archived = agent.status === "archived";
    const idle = agent.status === "idle";
    // intensity scales total volume
    const intensity = randInt(1, 10);
    let lastActive = agent.createdAt.getTime();

    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const dayStart = now - d * DAY;
      if (dayStart < agent.createdAt.getTime()) continue;
      // Archived: no activity in the most recent ~12 days
      if (archived && d < 12) continue;
      // Idle: sparse recent activity
      if (idle && d < 6 && rand() > 0.3) continue;
      // weekends lighter
      const dow = new Date(dayStart).getUTCDay();
      const weekend = dow === 0 || dow === 6;
      const runsToday = Math.max(
        0,
        Math.round(intensity * (weekend ? 0.3 : 1) * (0.5 + rand())),
      );
      for (let r = 0; r < runsToday; r++) {
        const ts = new Date(dayStart + Math.floor(rand() * DAY));
        const inputTokens = randInt(400, 12000);
        const outputTokens = randInt(150, 6000);
        usageEvents.push({
          agentId: agent.id,
          timestamp: ts,
          inputTokens,
          outputTokens,
        });
        if (ts.getTime() > lastActive) lastActive = ts.getTime();
      }
    }
    agent.lastActiveAt = new Date(lastActive);
  }

  console.log(`Inserting ${agents.length} agents...`);
  await db.insert(agentsTable).values(agents);

  console.log(`Inserting ${usageEvents.length} usage events...`);
  // batch insert
  const BATCH = 1000;
  for (let i = 0; i < usageEvents.length; i += BATCH) {
    await db.insert(usageEventsTable).values(usageEvents.slice(i, i + BATCH));
  }

  console.log("Seed complete.");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
