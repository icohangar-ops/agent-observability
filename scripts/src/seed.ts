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

const models = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    inputPricePerMillion: "2.5000",
    outputPricePerMillion: "10.0000",
    weight: 5,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "OpenAI",
    inputPricePerMillion: "0.1500",
    outputPricePerMillion: "0.6000",
    weight: 7,
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "Anthropic",
    inputPricePerMillion: "3.0000",
    outputPricePerMillion: "15.0000",
    weight: 5,
  },
  {
    id: "claude-3-haiku",
    name: "Claude 3 Haiku",
    provider: "Anthropic",
    inputPricePerMillion: "0.2500",
    outputPricePerMillion: "1.2500",
    weight: 4,
  },
  {
    id: "gemini-1-5-pro",
    name: "Gemini 1.5 Pro",
    provider: "Google",
    inputPricePerMillion: "1.2500",
    outputPricePerMillion: "5.0000",
    weight: 3,
  },
  {
    id: "llama-3-1-70b",
    name: "Llama 3.1 70B",
    provider: "Meta",
    inputPricePerMillion: "0.5000",
    outputPricePerMillion: "0.7500",
    weight: 3,
  },
];

const modelWeightPool: string[] = [];
for (const m of models) {
  for (let i = 0; i < m.weight; i++) modelWeightPool.push(m.id);
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
      inputPricePerMillion: m.inputPricePerMillion,
      outputPricePerMillion: m.outputPricePerMillion,
    })),
  );

  // Employees
  const employees: {
    id: string;
    name: string;
    role: string;
    departmentId: string;
  }[] = [];
  let empCounter = 0;
  for (const dept of departments) {
    const count = randInt(3, 5);
    for (let i = 0; i < count; i++) {
      empCounter++;
      const name = `${pick(firstNames)} ${pick(lastNames)}`;
      employees.push({
        id: `emp-${empCounter}`,
        name,
        role: pick(rolesByDept[dept.id]),
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
        modelId: pick(modelWeightPool),
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
