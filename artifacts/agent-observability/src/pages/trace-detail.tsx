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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  Minimize2,
  ZoomIn,
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
function prettyPrint(value: string): { text: string; isJson: boolean; data?: unknown } {
  const trimmed = value.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksJson) return { text: value, isJson: false };
  try {
    const parsed = JSON.parse(trimmed);
    return { text: JSON.stringify(parsed, null, 2), isJson: true, data: parsed };
  } catch {
    return { text: value, isJson: false };
  }
}

// Color-code a primitive JSON value into a themed span. Theme-aware via Tailwind
// dark: variants so it stays legible in both light and dark mode.
function primitiveNode(value: unknown): ReactNode {
  if (value === null) return <span className="text-rose-600 dark:text-rose-400">null</span>;
  switch (typeof value) {
    case "string":
      return (
        <span className="text-emerald-600 dark:text-emerald-400">{JSON.stringify(value)}</span>
      );
    case "number":
      return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
    case "boolean":
      return <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

// A single line/subtree of the JSON tree. Primitives render inline; objects and
// arrays delegate to JsonBranch so each gets its own collapse state.
function JsonNode({
  keyName,
  value,
  comma,
}: {
  keyName?: string;
  value: unknown;
  comma: boolean;
}) {
  const prefix =
    keyName !== undefined ? (
      <>
        <span className="text-sky-700 dark:text-sky-300">"{keyName}"</span>
        <span className="text-muted-foreground">: </span>
      </>
    ) : null;
  if (value !== null && typeof value === "object") {
    return <JsonBranch keyPrefix={prefix} value={value} comma={comma} />;
  }
  return (
    <div className="whitespace-pre-wrap break-words">
      {prefix}
      {primitiveNode(value)}
      {comma ? <span className="text-muted-foreground">,</span> : null}
    </div>
  );
}

// A collapsible object/array node. Click the bracket to fold the section; a
// collapsed node shows a compact summary like `{ … } 5 keys` / `[ … ] 12 items`.
function JsonBranch({
  keyPrefix,
  value,
  comma,
}: {
  keyPrefix: ReactNode;
  value: object;
  comma: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isArray = Array.isArray(value);
  const entries: Array<[string | undefined, unknown]> = isArray
    ? (value as unknown[]).map((v) => [undefined, v])
    : Object.entries(value as Record<string, unknown>);
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const count = entries.length;
  const trailingComma = comma ? <span className="text-muted-foreground">,</span> : null;

  if (count === 0) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {keyPrefix}
        <span className="text-muted-foreground">
          {open}
          {close}
        </span>
        {trailingComma}
      </div>
    );
  }

  const summary = isArray
    ? `${count} item${count === 1 ? "" : "s"}`
    : `${count} key${count === 1 ? "" : "s"}`;

  const Toggle = ({ children }: { children: ReactNode }) => (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      className="group inline-flex items-baseline gap-1 rounded text-left align-baseline hover:text-foreground"
      data-testid="button-json-toggle"
    >
      <ChevronRight
        className={`size-3 shrink-0 translate-y-0.5 text-muted-foreground transition-transform group-hover:text-foreground ${collapsed ? "" : "rotate-90"}`}
      />
      {children}
    </button>
  );

  if (collapsed) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {keyPrefix}
        <Toggle>
          <span className="text-muted-foreground">
            {open} … {close}{" "}
            <span className="opacity-70">{summary}</span>
          </span>
        </Toggle>
        {trailingComma}
      </div>
    );
  }

  return (
    <div>
      <div className="whitespace-pre-wrap break-words">
        {keyPrefix}
        <Toggle>
          <span className="text-muted-foreground">{open}</span>
        </Toggle>
      </div>
      <div className="ml-1.5 border-l border-border/50 pl-3">
        {entries.map(([k, v], idx) => (
          <JsonNode key={k ?? idx} keyName={k} value={v} comma={idx < count - 1} />
        ))}
      </div>
      <div className="whitespace-pre-wrap break-words">
        <span className="text-muted-foreground">{close}</span>
        {trailingComma}
      </div>
    </div>
  );
}

// Root of the folding JSON view used inside IOBlock (inline + expand dialog).
function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="font-mono text-xs leading-relaxed text-foreground">
      <JsonNode value={data} comma={false} />
    </div>
  );
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
  const data = result?.data;
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
                <div
                  className="max-h-[70vh] overflow-auto rounded-md bg-muted/50 p-4"
                  data-testid={`text-dialog-${key}`}
                >
                  {isJson ? (
                    <JsonTree data={data} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
                      {formatted}
                    </pre>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
      {formatted ? (
        isJson ? (
          <div className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3">
            <JsonTree data={data} />
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs font-mono text-foreground">
            {formatted}
          </pre>
        )
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
  const [zoom, setZoom] = useState<{ startMs: number; endMs: number; label: string } | null>(null);

  const { data: trace, isLoading } = useGetTrace(traceId || "", params, {
    query: { enabled: !!traceId, queryKey: ["trace", traceId, params] },
  });

  const spans = trace?.spans ?? [];
  const depths = useMemo(() => computeDepths(spans), [spans]);
  const traceStartMs = trace?.startTime ? Date.parse(trace.startTime) : 0;
  const totalMs = trace?.durationMs ?? 0;

  const rootName = spans.length > 0 ? spans[0].name : traceId;

  // The visible time window (in ms offsets from the trace start). With no zoom
  // it spans the whole trace; zooming to a span narrows it to that span's
  // start/end so tightly-packed sub-steps fill the available width.
  const windowStart = zoom ? zoom.startMs : 0;
  const windowEnd = zoom ? zoom.endMs : totalMs;
  const windowSpan = windowEnd - windowStart;

  // Project a millisecond offset within the trace onto a 0..100 position inside
  // the current window. Log scale compresses long stretches of wall-clock time
  // so that short spans and tightly-packed early activity stay legible when one
  // step dominates the window's duration.
  const project = (ms: number): number => {
    if (windowSpan <= 0) return 0;
    const clamped = Math.min(Math.max(ms, windowStart), windowEnd);
    const rel = clamped - windowStart;
    if (scale === "log") {
      return (Math.log1p(rel) / Math.log1p(windowSpan)) * 100;
    }
    return (rel / windowSpan) * 100;
  };

  // Inverse of project(): given a 0..100 position, return the millisecond offset
  // that lands there. Used to label evenly-spaced ruler ticks so the ms values
  // shift correctly when Log scale compresses the axis and when zoomed into a
  // narrower window.
  const projectInverse = (pct: number): number => {
    if (windowSpan <= 0) return 0;
    const frac = Math.min(Math.max(pct, 0), 100) / 100;
    if (scale === "log") {
      return windowStart + Math.expm1(frac * Math.log1p(windowSpan));
    }
    return windowStart + frac * windowSpan;
  };

  // Evenly-spaced ruler ticks (0%, 25%, ... 100%). Positions stay fixed; the
  // labels are derived through projectInverse so they adapt to Linear vs Log
  // and to the current zoom window.
  const rulerTicks = useMemo(
    () =>
      [0, 25, 50, 75, 100].map((pct) => ({
        pct,
        ms: projectInverse(pct),
      })),
    [scale, windowStart, windowSpan],
  );

  function zoomToSpan(span: TraceSpan) {
    const startMs = Date.parse(span.timestamp);
    if (totalMs <= 0 || !Number.isFinite(startMs)) return;
    const start = Math.max(startMs - traceStartMs, 0);
    const end = Math.min(start + span.latencyMs, totalMs);
    if (end <= start) return;
    setZoom({ startMs: start, endMs: end, label: span.name });
  }

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
                {zoom && (
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="max-w-[200px] gap-1 font-normal"
                      data-testid="badge-zoom-target"
                    >
                      <ZoomIn className="size-3 shrink-0" />
                      <span className="truncate">{zoom.label}</span>
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5"
                      onClick={() => setZoom(null)}
                      data-testid="button-zoom-reset"
                    >
                      <Minimize2 className="size-3.5" />
                      Full trace
                    </Button>
                  </div>
                )}
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
              {totalMs > 0 && (
                <div className="hidden sm:flex items-center gap-3 px-4 py-2 border-b bg-muted/20 text-[10px] font-mono text-muted-foreground select-none">
                  <div className="size-4 shrink-0" aria-hidden />
                  <div className="w-64 shrink-0" aria-hidden />
                  <div className="flex-1 relative h-4">
                    {rulerTicks.map((tick) => (
                      <div
                        key={tick.pct}
                        className="absolute top-0 bottom-0 flex flex-col items-center"
                        style={{
                          left: `${tick.pct}%`,
                          transform:
                            tick.pct === 0
                              ? "translateX(0)"
                              : tick.pct === 100
                                ? "translateX(-100%)"
                                : "translateX(-50%)",
                        }}
                      >
                        <span className="whitespace-nowrap leading-none">
                          {tick.ms <= 0 ? "0" : `+${formatLatency(tick.ms)}`}
                        </span>
                        <span className="mt-0.5 h-1.5 w-px bg-border" aria-hidden />
                      </div>
                    ))}
                  </div>
                  <div className="w-[140px] md:w-[230px] shrink-0" aria-hidden />
                </div>
              )}
              <TooltipProvider delayDuration={150}>
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
                  const spanEndOffset = startOffset + span.latencyMs;
                  const inWindow =
                    !hasOffset ||
                    (startOffset <= windowEnd && spanEndOffset >= windowStart);
                  const dimmed = zoom != null && !inWindow;
                  const isZoomTarget =
                    zoom != null &&
                    Math.abs(startOffset - zoom.startMs) < 0.001 &&
                    Math.abs(spanEndOffset - zoom.endMs) < 0.001;
                  const canZoom = hasOffset && totalMs > 0;
                  const bar = (
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
                  );
                  return (
                    <div
                      key={span.spanId}
                      className={`text-sm transition-opacity ${dimmed ? "opacity-40" : ""}`}
                    >
                      <div className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                        <button
                          type="button"
                          onClick={() => toggle(span.spanId)}
                          className="flex items-center gap-3 shrink-0 text-left"
                          data-testid={`row-trace-span-${span.spanId}`}
                        >
                          <ChevronRight
                            className={`size-4 text-muted-foreground shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          <div
                            className="flex items-center gap-2 shrink-0 w-64 min-w-0"
                            style={{ paddingLeft: `${depth * 16}px` }}
                          >
                            <KindBadge kind={span.kind} />
                            <span className="font-medium truncate">{span.name}</span>
                          </div>
                        </button>
                        <div className="flex-1 min-w-[80px] hidden sm:block">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              {canZoom ? (
                                <button
                                  type="button"
                                  onClick={() => zoomToSpan(span)}
                                  className={`group/bar block w-full cursor-zoom-in rounded transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isZoomTarget ? "ring-2 ring-ring" : ""}`}
                                  title={`Zoom to "${span.name}"`}
                                  aria-label={`Zoom timeline to ${span.name}`}
                                  data-testid={`button-zoom-span-${span.spanId}`}
                                >
                                  {bar}
                                </button>
                              ) : (
                                bar
                              )}
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              className="font-mono"
                              data-testid={`tooltip-span-${span.spanId}`}
                            >
                              {hasOffset ? (
                                <span>
                                  Starts at +{formatLatency(startOffset)} · lasts{" "}
                                  {formatLatency(span.latencyMs)}
                                </span>
                              ) : (
                                <span>Lasts {formatLatency(span.latencyMs)}</span>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="flex items-center justify-end gap-3 shrink-0 w-[140px] md:w-[230px]">
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
                        </div>
                      </div>
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
              </TooltipProvider>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
