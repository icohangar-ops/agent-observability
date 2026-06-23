import { useState } from "react";
import { useListTraces, useGetTraceSummary, type TraceSpan } from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatTokens, formatNumber } from "@/lib/format";
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
import { Search, Activity, AlertTriangle, Coins, Timer, Inbox } from "lucide-react";

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
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  accent?: string;
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
        </div>
      </CardContent>
    </Card>
  );
}

export default function Traces() {
  const { params } = useDateRange();
  const [kind, setKind] = useState<string>(ALL_KINDS);
  const [search, setSearch] = useState("");

  const queryParams = {
    ...params,
    ...(kind !== ALL_KINDS ? { kind } : {}),
    ...(search.trim() !== "" ? { q: search.trim() } : {}),
  };

  const { data: traces, isLoading: isTracesLoading } = useListTraces(queryParams);
  const { data: summary, isLoading: isSummaryLoading } = useGetTraceSummary(queryParams);

  const spans = traces?.spans ?? [];
  const noData = traces?.noData ?? false;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Agent Traces</h1>
        <p className="text-muted-foreground">
          Live agent and model execution spans pulled from Datadog LLM Observability.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {isSummaryLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[74px] w-full" />)
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
              label="Avg Latency"
              value={formatLatency(summary?.avgLatencyMs ?? 0)}
              icon={Timer}
              accent="bg-sky-500/15 text-sky-500"
            />
          </>
        )}
      </div>

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
      </div>

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
                  <TableHead>Time</TableHead>
                  <TableHead>Span</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Tokens (in / out)</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spans.map((span: TraceSpan) => (
                  <TableRow key={span.spanId} data-testid={`row-span-${span.spanId}`}>
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
