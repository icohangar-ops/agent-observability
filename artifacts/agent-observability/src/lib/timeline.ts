// Pure helpers that drive the trace detail span timeline layout: nesting depth
// (parentId walking) and the linear/log projection of millisecond offsets onto
// a 0..100 axis. Kept free of React so they can be unit-tested in isolation.

// Minimal shape needed to compute nesting depth; TraceSpan satisfies this.
export interface DepthSpan {
  spanId: string;
  parentId?: string | null;
}

// Compute nesting depth of each span by walking parentId links. Spans whose
// parent isn't in this trace (or that have none) are treated as roots (depth 0).
// A `seen` set guards against parentId cycles so a malformed trace can't recurse
// forever — the span that would close the loop is treated as a root instead.
export function computeDepths<T extends DepthSpan>(spans: T[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depths = new Map<string, number>();
  const resolve = (span: T, seen: Set<string>): number => {
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

export type TimelineScale = "linear" | "log";

// The visible time window (in ms offsets from the trace start) plus the active
// scale. windowSpan is derived as windowEnd - windowStart.
export interface ProjectOptions {
  windowStart: number;
  windowEnd: number;
  scale: TimelineScale;
}

// Project a millisecond offset within the trace onto a 0..100 position inside
// the current window. Offsets are clamped to the window before projecting. Log
// scale compresses long stretches of wall-clock time so that short spans and
// tightly-packed early activity stay legible when one step dominates. Returns 0
// for a zero/negative-width window (nothing to lay out).
export function projectMs(ms: number, opts: ProjectOptions): number {
  const { windowStart, windowEnd, scale } = opts;
  const windowSpan = windowEnd - windowStart;
  if (windowSpan <= 0) return 0;
  const clamped = Math.min(Math.max(ms, windowStart), windowEnd);
  const rel = clamped - windowStart;
  if (scale === "log") {
    return (Math.log1p(rel) / Math.log1p(windowSpan)) * 100;
  }
  return (rel / windowSpan) * 100;
}

// Inverse of projectMs(): given a 0..100 position, return the millisecond offset
// that lands there. The input percentage is clamped to 0..100. Used to label
// evenly-spaced ruler ticks so the ms values shift correctly under Log scale and
// when zoomed into a narrower window.
export function projectMsInverse(pct: number, opts: ProjectOptions): number {
  const { windowStart, windowEnd, scale } = opts;
  const windowSpan = windowEnd - windowStart;
  if (windowSpan <= 0) return 0;
  const frac = Math.min(Math.max(pct, 0), 100) / 100;
  if (scale === "log") {
    return windowStart + Math.expm1(frac * Math.log1p(windowSpan));
  }
  return windowStart + frac * windowSpan;
}
