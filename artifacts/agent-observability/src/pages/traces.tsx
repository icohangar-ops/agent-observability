import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  useListTraces,
  useGetTraceSummary,
  useGetTraceCostBreakdown,
  type TraceSpan,
  type TraceCostGroup,
} from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatTokens, formatNumber, formatUSD } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Activity,
  AlertTriangle,
  Coins,
  Timer,
  Inbox,
  DollarSign,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Cpu,
  Boxes,
  Building2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const ALL_KINDS = "__all__";

const KIND_OPTIONS = [
  { value: "agent", label: "Agent" },
  { value: "workflow", label: "Workflow" },
  { value: "llm", label: "LLM" },
  { value: "tool", label: "Tool" },
  { value: "task", label: "Task" },
  { value: "embedding", label: "Embedding" },
  { value: "retrieval", label: "Retrieval" },
];

const KIND_STYLES: Record<string, string> = {
  agent: "bg-primary/15 text-primary",
  workflow: "bg-violet-500/15 text-violet-500",
  llm: "bg-emerald-500/15 text-emerald-500",
  tool: "bg-amber-500/15 text-amber-500",
  task: "bg-sky-500/15 text-sky-500",
  embedding: "bg-pink-500/15 text-pink-500",
  retrieval: "bg-teal-500/15 text-teal-500",
};

function KindBadge({ kind }: { kind: string }) {
  const style = KIND_STYLES[kind] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${style}`}>
      {kind}
    </span>
  );
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

// Per-span costs are often a tiny fraction of a cent, so show enough precision
// for small values; fall back to standard 2-decimal USD once it is >= $0.01.
function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) {
    return `$${usd.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
  return formatUSD(usd);
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  accent?: string;
  hint?: string;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`size-9 rounded-md flex items-center justify-center ${accent ?? "bg-muted text-muted-foreground"}`}>
          <Icon className="size-4" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            {label}
          </div>
          <div className="text-xl font-medium font-mono">{value}</div>
          {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

type SortColumn = "time" | "name" | "cost" | "tokens" | "latency";
type SortDirection = "asc" | "desc";

const SORT_COLUMNS: SortColumn[] = ["time", "name", "cost", "tokens", "latency"];

function isSortColumn(value: string | null | undefined): value is SortColumn {
  return value != null && (SORT_COLUMNS as string[]).includes(value);
}

type GroupDimension = "model" | "app" | "department";

const GROUP_DIMENSIONS: GroupDimension[] = ["model", "app", "department"];

const GROUP_LABELS: Record<GroupDimension, string> = {
  model: "Model",
  app: "App",
  department: "Department",
};

function isGroupDimension(value: string | null | undefined): value is GroupDimension {
  return value != null && (GROUP_DIMENSIONS as string[]).includes(value);
}

interface GroupFilter {
  dimension: GroupDimension;
  value: string;
}

// "navigate" keeps the breakdown cards scoped to date/kind/search so they stay a
// stable navigation aid. "drillin" narrows the breakdown to the active group so
// the other cards reflect it (e.g. clicking a department shows its models/apps).
type BreakdownMode = "navigate" | "drillin";

const BREAKDOWN_MODES: BreakdownMode[] = ["navigate", "drillin"];

function isBreakdownMode(value: string | null | undefined): value is BreakdownMode {
  return value != null && (BREAKDOWN_MODES as string[]).includes(value);
}

interface TracesView {
  kind: string;
  search: string;
  sortColumn: SortColumn | null;
  sortDirection: SortDirection;
  group: GroupFilter | null;
  breakdownMode: BreakdownMode;
}

const VIEW_STORAGE_KEY = "agent-observability:traces-view";

function readStoredView(): Partial<TracesView> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<TracesView>;
  } catch {
    return {};
  }
}

// Prefer the URL (so shared/reloaded links win), then fall back to the last
// view saved in localStorage (so the sort survives <Link> navigation, which
// drops the query string), and finally the defaults.
function initialView(): TracesView {
  const url =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const stored = readStoredView();

  const sortRaw = url.get("sort") ?? stored.sortColumn ?? null;
  const sortColumn = isSortColumn(sortRaw) ? sortRaw : null;
  const dirRaw = url.get("dir") ?? stored.sortDirection ?? "desc";
  const sortDirection: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const groupDimRaw = url.get("group") ?? stored.group?.dimension ?? null;
  const groupValue = url.get("gval") ?? stored.group?.value ?? "";
  const group: GroupFilter | null =
    isGroupDimension(groupDimRaw) && groupValue !== ""
      ? { dimension: groupDimRaw, value: groupValue }
      : null;

  const modeRaw = url.get("bmode") ?? stored.breakdownMode ?? "navigate";
  const breakdownMode: BreakdownMode = isBreakdownMode(modeRaw) ? modeRaw : "navigate";

  return {
    kind: url.get("kind") ?? stored.kind ?? ALL_KINDS,
    search: url.get("q") ?? stored.search ?? "",
    sortColumn,
    sortDirection,
    group,
    breakdownMode,
  };
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <ArrowUpDown className="size-3.5 opacity-40" />;
  }
  return direction === "asc" ? (
    <ArrowUp className="size-3.5 text-primary" />
  ) : (
    <ArrowDown className="size-3.5 text-primary" />
  );
}

const SORT_COMPARATORS: Record<SortColumn, (a: TraceSpan, b: TraceSpan) => number> = {
  time: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  name: (a, b) => a.name.localeCompare(b.name),
  cost: (a, b) => a.estimatedCostUsd - b.estimatedCostUsd,
  tokens: (a, b) => a.totalTokens - b.totalTokens,
  latency: (a, b) => a.latencyMs - b.latencyMs,
};

function BreakdownCard({
  title,
  icon: Icon,
  accent,
  groups,
  emptyLabel,
  dimension,
  activeValue,
  onSelect,
}: {
  title: string;
  icon: typeof Activity;
  accent: string;
  groups: TraceCostGroup[];
  emptyLabel: string;
  dimension: GroupDimension;
  activeValue: string | null;
  onSelect: (dimension: GroupDimension, value: string) => void;
}) {
  const top = groups.filter((g) => g.cost > 0).slice(0, 5);
  const max = top.length > 0 ? top[0].cost : 0;
  return (
    <Card className="shadow-none">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className={`size-7 rounded-md flex items-center justify-center ${accent}`}>
            <Icon className="size-3.5" />
          </div>
          <div className="text-sm font-semibold">{title}</div>
        </div>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">{emptyLabel}</p>
        ) : (
          <div className="space-y-1">
            {top.map((g) => {
              const isActive = activeValue === g.key;
              return (
                <button
                  type="button"
                  key={g.key}
                  onClick={() => onSelect(dimension, g.key)}
                  aria-pressed={isActive}
                  title={`Filter spans by ${GROUP_LABELS[dimension].toLowerCase()}: ${g.key}`}
                  data-testid={`breakdown-row-${g.key}`}
                  className={`w-full space-y-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isActive ? "bg-muted ring-1 ring-primary/40" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium" title={g.key}>
                      {g.key}
                    </span>
                    <span className="font-mono whitespace-nowrap">{formatCost(g.cost)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-green-600/70"
                        style={{ width: `${max > 0 ? Math.max((g.cost / max) * 100, 2) : 0}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {Math.round(g.costShare * 100)}%
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Traces() {
  const { params } = useDateRange();
  const [location, navigate] = useLocation();
  const [initial] = useState(initialView);
  const [kind, setKind] = useState<string>(initial.kind);
  const [search, setSearch] = useState(initial.search);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(initial.sortColumn);
  const [sortDirection, setSortDirection] = useState<SortDirection>(initial.sortDirection);
  const [group, setGroup] = useState<GroupFilter | null>(initial.group);
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>(initial.breakdownMode);

  // Persist the current view so it survives <Link> navigation (which drops the
  // query string) and restores on the next visit even without a shared URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        VIEW_STORAGE_KEY,
        JSON.stringify({
          kind,
          search,
          sortColumn,
          sortDirection,
          group,
          breakdownMode,
        } satisfies TracesView),
      );
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [kind, search, sortColumn, sortDirection, group, breakdownMode]);

  // Reflect the view in the URL so it is shareable and survives a reload. Keys
  // are set/deleted in place to preserve ordering and avoid fighting the
  // date-range sync over the same query string.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = window.location.search.replace(/^\?/, "");
    const next = new URLSearchParams(current);
    if (kind !== ALL_KINDS) next.set("kind", kind);
    else next.delete("kind");
    const trimmed = search.trim();
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    if (sortColumn) {
      next.set("sort", sortColumn);
      next.set("dir", sortDirection);
    } else {
      next.delete("sort");
      next.delete("dir");
    }
    if (group) {
      next.set("group", group.dimension);
      next.set("gval", group.value);
    } else {
      next.delete("group");
      next.delete("gval");
    }
    if (breakdownMode !== "navigate") {
      next.set("bmode", breakdownMode);
    } else {
      next.delete("bmode");
    }
    const desired = next.toString();
    if (current === desired) return;
    navigate(`${location}${desired ? `?${desired}` : ""}`, { replace: true });
  }, [kind, search, sortColumn, sortDirection, group, breakdownMode, location, navigate]);

  // Clicking a breakdown row toggles a single-group filter on the table; clicking
  // the active row again clears it. Only one group dimension can be active at a
  // time so the table always maps to exactly one card row.
  function selectGroup(dimension: GroupDimension, value: string) {
    setGroup((prev) =>
      prev && prev.dimension === dimension && prev.value === value
        ? null
        : { dimension, value },
    );
  }

  const groupParams = group ? { [group.dimension]: group.value } : {};

  // Base scope shared by every query: date range + kind + search.
  const baseParams = {
    ...params,
    ...(kind !== ALL_KINDS ? { kind } : {}),
    ...(search.trim() !== "" ? { q: search.trim() } : {}),
  };

  // In "navigate" mode the breakdown stays scoped to date/kind/search only, so
  // it keeps showing every group as a stable navigation aid. In "drillin" mode
  // it additionally narrows to the active group, so the other cards reflect that
  // group (e.g. clicking a department reveals which models/apps it used). The
  // table and summary always narrow to the clicked group regardless of mode.
  const breakdownParams =
    breakdownMode === "drillin" ? { ...baseParams, ...groupParams } : baseParams;
  const queryParams = { ...baseParams, ...groupParams };

  const { data: traces, isLoading: isTracesLoading } = useListTraces(queryParams);
  const { data: summary, isLoading: isSummaryLoading } = useGetTraceSummary(queryParams);
  const { data: breakdown, isLoading: isBreakdownLoading } =
    useGetTraceCostBreakdown(breakdownParams);

  const noData = traces?.noData ?? false;
  const byModel = breakdown?.byModel ?? [];
  const byApp = breakdown?.byApp ?? [];
  const byDepartment = breakdown?.byDepartment ?? [];
  const hasBreakdown =
    !breakdown?.noData &&
    (byModel.some((g) => g.cost > 0) ||
      byApp.some((g) => g.cost > 0) ||
      byDepartment.some((g) => g.cost > 0));

  const hasActiveView =
    kind !== ALL_KINDS || search.trim() !== "" || sortColumn !== null;

  function resetView() {
    setKind(ALL_KINDS);
    setSearch("");
    setSortColumn(null);
    setSortDirection("desc");
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(VIEW_STORAGE_KEY);
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
    }
  }

  function toggleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  }

  const rawSpans = traces?.spans ?? [];
  const spans =
    sortColumn === null
      ? rawSpans
      : [...rawSpans].sort((a, b) => {
          const diff = SORT_COMPARATORS[sortColumn](a, b);
          return sortDirection === "asc" ? diff : -diff;
        });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Agent Traces</h1>
        <p className="text-muted-foreground">
          Live agent and model execution spans pulled from Datadog LLM Observability.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {isSummaryLoading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[74px] w-full" />)
        ) : (
          <>
            <SummaryCard
              label="Spans"
              value={formatNumber(summary?.spanCount ?? 0)}
              icon={Activity}
              accent="bg-primary/15 text-primary"
            />
            <SummaryCard
              label="Errors"
              value={formatNumber(summary?.errorCount ?? 0)}
              icon={AlertTriangle}
              accent={
                (summary?.errorCount ?? 0) > 0
                  ? "bg-destructive/15 text-destructive"
                  : "bg-muted text-muted-foreground"
              }
            />
            <SummaryCard
              label="Tokens"
              value={formatTokens(summary?.totalTokens ?? 0)}
              icon={Coins}
              accent="bg-emerald-500/15 text-emerald-500"
            />
            <SummaryCard
              label="Est. Cost"
              value={formatCost(summary?.estimatedCostUsd ?? 0)}
              icon={DollarSign}
              accent="bg-green-600/15 text-green-600"
              hint="Datadog estimate"
            />
            <SummaryCard
              label="Avg Latency"
              value={formatLatency(summary?.avgLatencyMs ?? 0)}
              icon={Timer}
              accent="bg-sky-500/15 text-sky-500"
            />
          </>
        )}
      </div>

      {isBreakdownLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[200px] w-full" />
        </div>
      ) : hasBreakdown ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">Cost breakdown</div>
            <div
              className="inline-flex items-center rounded-md border p-0.5"
              role="group"
              aria-label="Breakdown mode"
              data-testid="breakdown-mode-toggle"
            >
              {BREAKDOWN_MODES.map((mode) => {
                const isActive = breakdownMode === mode;
                const label = mode === "navigate" ? "Navigate" : "Drill in";
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setBreakdownMode(mode)}
                    aria-pressed={isActive}
                    title={
                      mode === "navigate"
                        ? "Keep the cards showing every group as a navigation aid"
                        : "Narrow the cards to the selected group"
                    }
                    data-testid={`breakdown-mode-${mode}`}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <BreakdownCard
              title="Top models by est. cost"
              icon={Cpu}
              accent="bg-emerald-500/15 text-emerald-500"
              groups={byModel}
              emptyLabel="No model cost recorded for these spans."
              dimension="model"
              activeValue={group?.dimension === "model" ? group.value : null}
              onSelect={selectGroup}
            />
            <BreakdownCard
              title="Top apps by est. cost"
              icon={Boxes}
              accent="bg-violet-500/15 text-violet-500"
              groups={byApp}
              emptyLabel="No app cost recorded for these spans."
              dimension="app"
              activeValue={group?.dimension === "app" ? group.value : null}
              onSelect={selectGroup}
            />
            <BreakdownCard
              title="Top departments by est. cost"
              icon={Building2}
              accent="bg-amber-500/15 text-amber-500"
              groups={byDepartment}
              emptyLabel="No department cost recorded for these spans."
              dimension="department"
              activeValue={group?.dimension === "department" ? group.value : null}
              onSelect={selectGroup}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Costs are Datadog estimates, grouped over the active date range and filters. Click a row
            to filter the spans below.{" "}
            {breakdownMode === "drillin"
              ? group
                ? "Drill-in is on, so these cards reflect the selected group."
                : "Drill-in is on — select a row and the other cards will reflect it."
              : "Switch to Drill in to make these cards reflect the selected group."}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search spans, models, providers..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-traces"
          />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-full sm:w-48" data-testid="select-kind">
            <SelectValue placeholder="All kinds" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_KINDS}>All kinds</SelectItem>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveView && (
          <Button
            type="button"
            variant="ghost"
            onClick={resetView}
            className="w-full sm:w-auto text-muted-foreground"
            data-testid="button-reset-view"
          >
            <X className="size-4" />
            Reset
          </Button>
        )}
      </div>

      {group && (
        <div className="flex items-center gap-2 text-sm" data-testid="active-group-filter">
          <span className="text-muted-foreground">Filtered by</span>
          <button
            type="button"
            onClick={() => setGroup(null)}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 font-medium text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="button-clear-group-filter"
            aria-label={`Clear ${GROUP_LABELS[group.dimension].toLowerCase()} filter`}
          >
            <span className="text-muted-foreground">{GROUP_LABELS[group.dimension]}:</span>
            <span className="max-w-[16rem] truncate" title={group.value}>
              {group.value}
            </span>
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isTracesLoading ? (
            <div className="p-6">
              <Skeleton className="h-[360px] w-full" />
            </div>
          ) : noData ? (
            <div className="p-12 text-center flex flex-col items-center gap-3">
              <div className="size-12 rounded-full bg-muted flex items-center justify-center">
                <Inbox className="size-6 text-muted-foreground" />
              </div>
              <div className="font-medium">No traces yet</div>
              <p className="text-sm text-muted-foreground max-w-md">
                Datadog LLM Observability has no agent traces for this org yet. Once your agents
                start emitting spans, they will appear here automatically.
              </p>
            </div>
          ) : spans.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center gap-3">
              <div className="size-12 rounded-full bg-muted flex items-center justify-center">
                <Search className="size-6 text-muted-foreground" />
              </div>
              <div className="font-medium">No spans match your filters</div>
              <p className="text-sm text-muted-foreground max-w-md">
                Try a different span kind, clearing the search, or widening the reporting window.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="p-0">
                    <button
                      type="button"
                      onClick={() => toggleSort("time")}
                      className="inline-flex items-center gap-1 h-12 px-4 hover:text-foreground transition-colors"
                      data-testid="sort-time"
                    >
                      Time
                      <SortIcon active={sortColumn === "time"} direction={sortDirection} />
                    </button>
                  </TableHead>
                  <TableHead className="p-0">
                    <button
                      type="button"
                      onClick={() => toggleSort("name")}
                      className="inline-flex items-center gap-1 h-12 px-4 hover:text-foreground transition-colors"
                      data-testid="sort-name"
                    >
                      Span
                      <SortIcon active={sortColumn === "name"} direction={sortDirection} />
                    </button>
                  </TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right p-0">
                    <button
                      type="button"
                      onClick={() => toggleSort("tokens")}
                      className="inline-flex items-center justify-end gap-1 w-full h-12 px-4 hover:text-foreground transition-colors"
                      data-testid="sort-tokens"
                    >
                      Tokens (in / out)
                      <SortIcon active={sortColumn === "tokens"} direction={sortDirection} />
                    </button>
                  </TableHead>
                  <TableHead className="text-right p-0">
                    <button
                      type="button"
                      onClick={() => toggleSort("cost")}
                      className="inline-flex items-center justify-end gap-1 w-full h-12 px-4 hover:text-foreground transition-colors"
                      data-testid="sort-cost"
                    >
                      Est. Cost
                      <SortIcon active={sortColumn === "cost"} direction={sortDirection} />
                    </button>
                  </TableHead>
                  <TableHead className="text-right p-0">
                    <button
                      type="button"
                      onClick={() => toggleSort("latency")}
                      className="inline-flex items-center justify-end gap-1 w-full h-12 px-4 hover:text-foreground transition-colors"
                      data-testid="sort-latency"
                    >
                      Latency
                      <SortIcon active={sortColumn === "latency"} direction={sortDirection} />
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spans.map((span: TraceSpan) => (
                  <TableRow
                    key={span.spanId}
                    data-testid={`row-span-${span.spanId}`}
                    className="cursor-pointer"
                    onClick={() => navigate(`/traces/${span.traceId}`)}
                  >
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(span.timestamp)}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{span.name}</div>
                      {span.mlApp && (
                        <div className="text-xs text-muted-foreground">{span.mlApp}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <KindBadge kind={span.kind} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {span.model ? (
                        <div>
                          <div>{span.model}</div>
                          {span.provider && (
                            <div className="text-xs text-muted-foreground">{span.provider}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {span.totalTokens > 0 ? (
                        <span>
                          {formatTokens(span.inputTokens)}{" "}
                          <span className="text-muted-foreground">/</span>{" "}
                          {formatTokens(span.outputTokens)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {span.estimatedCostUsd > 0 ? (
                        formatCost(span.estimatedCostUsd)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatLatency(span.latencyMs)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={span.status === "error" ? "destructive" : "secondary"}>
                        {span.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
