/**
 * Real usage ingestion.
 *
 * Populates the same tables the dashboard reads (departments, employees,
 * models, agents, usage_events) from real source files instead of the
 * synthetic sample generator in `seed.ts`. This is the path the CFO's real
 * numbers flow through; `seed.ts` is now only a dev/fallback convenience.
 *
 * Sources (all in the data dir, default `scripts/data`, override with
 * INGEST_DATA_DIR):
 *
 *   1. models.json       — the per-model pricing catalog (kept current here).
 *                          Costs are never stored; they are always derived from
 *                          tokens x this pricing by the API, so updating prices
 *                          here re-prices all history consistently.
 *   2. directory.json    — the org + agent registry (departments, employees,
 *                          agents). Could come from an HR system / agent config.
 *   3. usage-log.ndjson  — the raw metered events (one JSON object per line).
 *                          This is the large, append-only export from provider
 *                          billing exports or an internal usage log.
 *
 * Ingestion is idempotent and incremental:
 *   - dimension rows (departments/employees/models/agents) are upserted;
 *   - usage events are deduped on their source `eventId` (stored as
 *     usage_events.external_id with a unique constraint), so re-running the
 *     same export never double-counts and appending a newer export just adds
 *     the new rows.
 *
 * Pass `--reset` to wipe all tables before loading (use for a clean full load).
 *
 * Run: pnpm --filter @workspace/scripts run ingest
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db,
  pool,
  sql,
  departmentsTable,
  modelsTable,
  employeesTable,
  agentsTable,
  usageEventsTable,
} from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR =
  process.env.INGEST_DATA_DIR ?? path.join(__dirname, "..", "data");

const RESET = process.argv.includes("--reset");

type ModelRow = {
  id: string;
  name: string;
  provider: string;
  tier: string;
  inputPricePerMillion: string | number;
  outputPricePerMillion: string | number;
};

type Directory = {
  departments: { id: string; name: string }[];
  employees: {
    id: string;
    name: string;
    role: string;
    accessTier: string;
    departmentId: string;
  }[];
  agents: {
    id: string;
    name: string;
    purpose: string;
    status: string;
    employeeId: string;
    modelId: string;
    // Optional — when absent, derived from the earliest usage event.
    createdAt?: string;
  }[];
};

type UsageRecord = {
  eventId: string;
  agentId: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
};

function readJson<T>(file: string): T {
  const full = path.join(DATA_DIR, file);
  if (!existsSync(full)) {
    throw new Error(
      `Missing source file: ${full}. Expected models.json, directory.json and usage-log.ndjson in ${DATA_DIR}.`,
    );
  }
  return JSON.parse(readFileSync(full, "utf8")) as T;
}

function readNdjson(file: string): UsageRecord[] {
  const full = path.join(DATA_DIR, file);
  if (!existsSync(full)) {
    throw new Error(`Missing source file: ${full}.`);
  }
  const out: UsageRecord[] = [];
  const text = readFileSync(full, "utf8");
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let rec: UsageRecord;
    try {
      rec = JSON.parse(line) as UsageRecord;
    } catch {
      throw new Error(`Invalid JSON on line ${lineNo} of ${file}: ${line}`);
    }
    if (
      !rec.eventId ||
      !rec.agentId ||
      !rec.timestamp ||
      typeof rec.inputTokens !== "number" ||
      typeof rec.outputTokens !== "number"
    ) {
      throw new Error(
        `Usage record on line ${lineNo} of ${file} is missing required fields ` +
          `(eventId, agentId, timestamp, inputTokens, outputTokens).`,
      );
    }
    out.push(rec);
  }
  return out;
}

async function main() {
  console.log(`Ingesting real usage from ${DATA_DIR}`);

  const models = readJson<ModelRow[]>("models.json");
  const directory = readJson<Directory>("directory.json");
  const usage = readNdjson("usage-log.ndjson");

  // Validate referential integrity up front so we fail loudly rather than
  // silently dropping rows.
  const modelIds = new Set(models.map((m) => m.id));
  const deptIds = new Set(directory.departments.map((d) => d.id));
  const empIds = new Set(directory.employees.map((e) => e.id));
  const agentIds = new Set(directory.agents.map((a) => a.id));

  for (const e of directory.employees) {
    if (!deptIds.has(e.departmentId)) {
      throw new Error(
        `Employee ${e.id} references unknown department ${e.departmentId}.`,
      );
    }
  }
  for (const a of directory.agents) {
    if (!empIds.has(a.employeeId)) {
      throw new Error(
        `Agent ${a.id} references unknown employee ${a.employeeId}.`,
      );
    }
    if (!modelIds.has(a.modelId)) {
      throw new Error(`Agent ${a.id} references unknown model ${a.modelId}.`);
    }
  }
  for (const u of usage) {
    if (!agentIds.has(u.agentId)) {
      throw new Error(
        `Usage event ${u.eventId} references unknown agent ${u.agentId}.`,
      );
    }
  }

  // Derive each agent's activity window from the usage log.
  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  for (const u of usage) {
    const t = new Date(u.timestamp).getTime();
    if (Number.isNaN(t)) {
      throw new Error(`Usage event ${u.eventId} has invalid timestamp.`);
    }
    if (!firstSeen.has(u.agentId) || t < firstSeen.get(u.agentId)!) {
      firstSeen.set(u.agentId, t);
    }
    if (!lastSeen.has(u.agentId) || t > lastSeen.get(u.agentId)!) {
      lastSeen.set(u.agentId, t);
    }
  }

  if (RESET) {
    console.log("--reset: clearing existing data...");
    await db.delete(usageEventsTable);
    await db.delete(agentsTable);
    await db.delete(employeesTable);
    await db.delete(modelsTable);
    await db.delete(departmentsTable);
  }

  // 1. Pricing catalog — keep per-model pricing current.
  console.log(`Upserting ${models.length} models...`);
  await db
    .insert(modelsTable)
    .values(
      models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        tier: m.tier,
        inputPricePerMillion: String(m.inputPricePerMillion),
        outputPricePerMillion: String(m.outputPricePerMillion),
      })),
    )
    .onConflictDoUpdate({
      target: modelsTable.id,
      set: {
        name: sql`excluded.name`,
        provider: sql`excluded.provider`,
        tier: sql`excluded.tier`,
        inputPricePerMillion: sql`excluded.input_price_per_million`,
        outputPricePerMillion: sql`excluded.output_price_per_million`,
      },
    });

  // 2. Departments.
  console.log(`Upserting ${directory.departments.length} departments...`);
  await db
    .insert(departmentsTable)
    .values(directory.departments)
    .onConflictDoUpdate({
      target: departmentsTable.id,
      set: { name: sql`excluded.name` },
    });

  // 3. Employees.
  console.log(`Upserting ${directory.employees.length} employees...`);
  await db
    .insert(employeesTable)
    .values(directory.employees)
    .onConflictDoUpdate({
      target: employeesTable.id,
      set: {
        name: sql`excluded.name`,
        role: sql`excluded.role`,
        accessTier: sql`excluded.access_tier`,
        departmentId: sql`excluded.department_id`,
      },
    });

  // 4. Agents — createdAt/lastActiveAt derived from usage where available.
  console.log(`Upserting ${directory.agents.length} agents...`);
  const now = Date.now();
  const agentValues = directory.agents.map((a) => {
    const first = firstSeen.get(a.id);
    const last = lastSeen.get(a.id);
    const createdAt = a.createdAt
      ? new Date(a.createdAt)
      : new Date(first ?? now);
    const lastActiveAt = new Date(last ?? createdAt.getTime());
    return {
      id: a.id,
      name: a.name,
      purpose: a.purpose,
      status: a.status,
      employeeId: a.employeeId,
      modelId: a.modelId,
      createdAt,
      lastActiveAt,
    };
  });
  await db
    .insert(agentsTable)
    .values(agentValues)
    .onConflictDoUpdate({
      target: agentsTable.id,
      set: {
        name: sql`excluded.name`,
        purpose: sql`excluded.purpose`,
        status: sql`excluded.status`,
        employeeId: sql`excluded.employee_id`,
        modelId: sql`excluded.model_id`,
        // Keep the earliest creation and latest activity across loads.
        createdAt: sql`least(${agentsTable.createdAt}, excluded.created_at)`,
        lastActiveAt: sql`greatest(${agentsTable.lastActiveAt}, excluded.last_active_at)`,
      },
    });

  // 5. Usage events — deduped on the source eventId (external_id).
  console.log(`Ingesting ${usage.length} usage events...`);
  const eventValues = usage.map((u) => ({
    externalId: u.eventId,
    agentId: u.agentId,
    timestamp: new Date(u.timestamp),
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
  }));
  const BATCH = 1000;
  let inserted = 0;
  for (let i = 0; i < eventValues.length; i += BATCH) {
    const res = await db
      .insert(usageEventsTable)
      .values(eventValues.slice(i, i + BATCH))
      .onConflictDoNothing({ target: usageEventsTable.externalId })
      .returning({ id: usageEventsTable.id });
    inserted += res.length;
  }
  const skipped = usage.length - inserted;
  console.log(
    `Ingest complete. Inserted ${inserted} new events` +
      (skipped > 0 ? `, skipped ${skipped} already-seen events.` : "."),
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
