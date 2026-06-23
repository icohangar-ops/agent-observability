import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import { useGetTrace, type TraceSpan } from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatTokens, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  AlertTriangle,
  Coins,
  Timer,
  Inbox,
  ChevronRight,
  Copy,
  Check,
  Maximize2,
} from "lucide-react";

const KIND_STYLES: Record<string, string> = {
  agent: "bg-primary/15 text-primary",
  workflow: "bg-violet-500/15 text-violet-500",
  llm: "bg-emerald-500/15 text-emerald-500",
  tool: "bg-amber-500/15 text-amber-500",
  task: "bg-sky-500/15 text-sky-500",
  embedding: "bg-pink-500/15 text-pink-500",
  retrieval: "bg-teal-500/15 text-teal-500",
};

const KIND_BAR: Record<string, string> = {
  agent: "bg-primary",
  workflow: "bg-violet-500",
  llm: "bg-emerald-500",
  tool: "bg-amber-500",
  task: "bg-sky-500",
  embedding: "bg-pink-500",
  retrieval: "bg-teal-500",
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
        <div
          className={`size-9 rounded-md flex items-center justify-center ${accent ?? "bg-muted text-muted-foreground"}`}
        >
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

// Compute nesting depth of each span by walking parentId links. Spans whose
// parent isn't in this trace (or that have none) are treated as roots (depth 0).
function computeDepths(spans: TraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depths = new Map<string, number>();
  const resolve = (span: TraceSpan, seen: Set<string>): number => {
    const cached = depths.get(span.spanId);
    if (cached != null) return cached;
    let depth = 0;
    if (span.parentId && byId.has(span.parentId) && !seen.has(span.parentId)) {
      seen.add(span.spanId);
      depth = resolve(byId.get(span.parentId)!, seen) + 1;
    }
    depths.set(span.spanId, depth);
    return depth;
  };
  for (const s of spans) resolve(s, new Set([s.spanId]));
  return depths;
}

// Pretty-print JSON-looking strings so large tool payloads are readable; leave
// plain text (and anything that doesn't parse) untouched. `isJson` tells the
// renderer whether to apply syntax highlighting.
function prettyPrint(value: string): { text: string; isJson: boolean } {
  const trimmed = value.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksJson) return { text: value, isJson: false };
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), isJson: true };
  } catch {
    return { text: value, isJson: false };
  }
}

// Matches JSON tokens: strings, true/false/null, and numbers. Everything else
// (braces, commas, colons, whitespace) is emitted verbatim as punctuation.
const JSON_TOKEN_RE = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Color-code pretty-printed JSON into themed spans. Theme-aware via Tailwind
// dark: variants so it stays legible in both light and dark mode.
function highlightJson(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  JSON_TOKEN_RE.lastIndex = 0;
  while ((match = JSON_TOKEN_RE.exec(code)) !== null) {
    const token = match[0];
    const start = match.index;
    if (start > last) nodes.push(code.slice(last, start));
    let cls: string;
    if (token[0] === '"') {
      cls = /^\s*:/.test(code.slice(start + token.length))
        ? "text-sky-700 dark:text-sky-300"
        : "text-emerald-600 dark:text-emerald-400";
    } else if (token === "true" || token === "false") {
      cls = "text-violet-600 dark:text-violet-400";
    } else if (token === "null") {
      cls = "text-rose-600 dark:text-rose-400";
    } else {
      cls = "text-amber-600 dark:text-amber-400";
    }
    nodes.push(
      <span key={key++} className={cls}>
        {token}
      </span>,
    );
    last = start + token.length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "destructive" });
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
      onClick={copy}
      data-testid={testId}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function IOBlock({
  label,
  value,
  spanId,
}: {
  label: string;
  value: string | null | undefined;
  spanId: string;
}) {
  const result = value ? prettyPrint(value) : null;
  const formatted = result?.text ?? null;
  const isJson = result?.isJson ?? false;
  const key = `${label.toLowerCase()}-${spanId}`;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        {formatted && (
          <div className="flex items-center gap-0.5">
            <CopyButton value={formatted} testId={`button-copy-${key}`} />
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                  data-testid={`button-expand-${key}`}
                >
                  <Maximize2 className="size-3.5" />
                  Expand
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-3">
                    <span>{label}</span>
                    <CopyButton value={formatted} testId={`button-copy-dialog-${key}`} />
                  </DialogTitle>
                </DialogHeader>
                <pre
                  className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 text-xs font-mono text-foreground"
                  data-testid={`text-dialog-${key}`}
                >
                  {isJson ? highlightJson(formatted) : formatted}
                </pre>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
      {formatted ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs font-mono text-foreground">
          {isJson ? highlightJson(formatted) : formatted}
        </pre>
      ) : (
        <div className="text-xs text-muted-foreground italic">No {label.toLowerCase()} recorded</div>
      )}
    </div>
  );
}

export default function TraceDetail() {
  const { traceId } = useParams<{ traceId: string }>();
  const { params } = useDateRange();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scale, setScale] = useState<"linear" | "log">("linear");

  const { data: trace, isLoading } = useGetTrace(traceId || "", params, {
    query: { enabled: !!traceId, queryKey: ["trace", traceId, params] },
  });

  const spans = trace?.spans ?? [];
  const depths = useMemo(() => computeDepths(spans), [spans]);
  const traceStartMs = trace?.startTime ? Date.parse(trace.startTime) : 0;
  const totalMs = trace?.durationMs ?? 0;

  const rootName = spans.length > 0 ? spans[0].name : traceId;

  // Project a millisecond offset within the trace (0..totalMs) onto a 0..100
  // position. Log scale compresses long stretches of wall-clock time so that
  // short spans and tightly-packed early activity stay legible when one step
  // dominates the overall duration.
  const project = (ms: number): number => {
    if (totalMs <= 0) return 0;
    const clamped = Math.min(Math.max(ms, 0), totalMs);
    if (scale === "log") {
      return (Math.log1p(clamped) / Math.log1p(totalMs)) * 100;
    }
    return (clamped / totalMs) * 100;
  };

  function toggle(spanId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <Link href="/traces">
              <BreadcrumbLink asChild>
                <span>Traces</span>
              </BreadcrumbLink>
            </Link>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{rootName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">{rootName}</h1>
        <p className="text-muted-foreground font-mono text-xs">trace {traceId}</p>
      </div>

      {trace && !trace.found ? (
        <Card>
          <CardContent className="p-12 text-center flex flex-col items-center gap-3">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center">
              <Inbox className="size-6 text-muted-foreground" />
            </div>
            <div className="font-medium">This trace has no spans</div>
            <p className="text-sm text-muted-foreground max-w-md">
              No spans matched this trace in the selected reporting window. Try widening the date
              range from the header.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard
              label="Spans"
              value={formatNumber(trace?.spanCount ?? 0)}
              icon={Activity}
              accent="bg-primary/15 text-primary"
            />
            <SummaryCard
              label="Errors"
              value={formatNumber(trace?.errorCount ?? 0)}
              icon={AlertTriangle}
              accent={
                (trace?.errorCount ?? 0) > 0
                  ? "bg-destructive/15 text-destructive"
                  : "bg-muted text-muted-foreground"
              }
            />
            <SummaryCard
              label="Tokens"
              value={formatTokens(trace?.totalTokens ?? 0)}
              icon={Coins}
              accent="bg-emerald-500/15 text-emerald-500"
            />
            <SummaryCard
              label="Duration"
              value={formatLatency(totalMs)}
              icon={Timer}
              accent="bg-sky-500/15 text-sky-500"
            />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <CardTitle>Span timeline</CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">Scale</span>
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={scale}
                  onValueChange={(v) => {
                    if (v === "linear" || v === "log") setScale(v);
                  }}
                  className="border rounded-md"
                >
                  <ToggleGroupItem value="linear" data-testid="button-scale-linear">
                    Linear
                  </ToggleGroupItem>
                  <ToggleGroupItem value="log" data-testid="button-scale-log">
                    Log
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {spans.map((span) => {
                  const depth = depths.get(span.spanId) ?? 0;
                  const startMs = Date.parse(span.timestamp);
                  const hasOffset = totalMs > 0 && Number.isFinite(startMs);
                  const startOffset = hasOffset ? startMs - traceStartMs : 0;
                  const offsetPct = hasOffset ? project(startOffset) : 0;
                  const endPct = hasOffset
                    ? project(startOffset + span.latencyMs)
                    : 100;
                  const widthPct =
                    totalMs > 0 ? Math.max(endPct - offsetPct, 0.5) : 100;
                  const isOpen = expanded.has(span.spanId);
                  const barColor =
                    span.status === "error" ? "bg-destructive" : KIND_BAR[span.kind] ?? "bg-primary";
                  return (
                    <div key={span.spanId} className="text-sm">
                      <button
                        type="button"
                        onClick={() => toggle(span.spanId)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                        data-testid={`row-trace-span-${span.spanId}`}
                      >
                        <ChevronRight
                          className={`size-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
                        />
                        <div
                          className="flex items-center gap-2 shrink-0"
                          style={{ paddingLeft: `${depth * 16}px` }}
                        >
                          <KindBadge kind={span.kind} />
                          <span className="font-medium">{span.name}</span>
                        </div>
                        <div className="flex-1 min-w-[80px] hidden sm:block">
                          <div className="relative h-2 rounded bg-muted">
                            <div
                              className={`absolute top-0 h-2 rounded ${barColor}`}
                              style={{
                                left: `${Math.min(Math.max(offsetPct, 0), 100)}%`,
                                width: `${Math.min(widthPct, 100)}%`,
                                minWidth: "3px",
                              }}
                            />
                          </div>
                        </div>
                        <span className="font-mono text-xs text-muted-foreground w-16 text-right shrink-0">
                          {formatLatency(span.latencyMs)}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground w-20 text-right shrink-0 hidden md:inline">
                          {span.totalTokens > 0 ? formatTokens(span.totalTokens) : "—"}
                        </span>
                        <Badge
                          variant={span.status === "error" ? "destructive" : "secondary"}
                          className="shrink-0"
                        >
                          {span.status}
                        </Badge>
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 pt-1 space-y-3 bg-muted/20">
                          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                            {span.model && (
                              <span>
                                Model: <span className="text-foreground">{span.model}</span>
                                {span.provider ? ` (${span.provider})` : ""}
                              </span>
                            )}
                            {span.totalTokens > 0 && (
                              <span>
                                Tokens:{" "}
                                <span className="text-foreground font-mono">
                                  {formatTokens(span.inputTokens, false)} in /{" "}
                                  {formatTokens(span.outputTokens, false)} out
                                </span>
                              </span>
                            )}
                            {span.mlApp && (
                              <span>
                                ml_app: <span className="text-foreground">{span.mlApp}</span>
                              </span>
                            )}
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <IOBlock label="Input" value={span.input} spanId={span.spanId} />
                            <IOBlock label="Output" value={span.output} spanId={span.spanId} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
