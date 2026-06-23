import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  serial,
  index,
} from "drizzle-orm/pg-core";

export const departmentsTable = pgTable("departments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const modelsTable = pgTable("models", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  inputPricePerMillion: numeric("input_price_per_million", {
    precision: 12,
    scale: 4,
  }).notNull(),
  outputPricePerMillion: numeric("output_price_per_million", {
    precision: 12,
    scale: 4,
  }).notNull(),
});

export const employeesTable = pgTable("employees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  departmentId: text("department_id")
    .notNull()
    .references(() => departmentsTable.id),
});

export const agentsTable = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employeesTable.id),
    modelId: text("model_id")
      .notNull()
      .references(() => modelsTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("agents_employee_idx").on(t.employeeId),
    index("agents_model_idx").on(t.modelId),
  ],
);

export const usageEventsTable = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
  },
  (t) => [
    index("usage_agent_idx").on(t.agentId),
    index("usage_timestamp_idx").on(t.timestamp),
  ],
);

export type Department = typeof departmentsTable.$inferSelect;
export type Model = typeof modelsTable.$inferSelect;
export type Employee = typeof employeesTable.$inferSelect;
export type Agent = typeof agentsTable.$inferSelect;
export type UsageEvent = typeof usageEventsTable.$inferSelect;
