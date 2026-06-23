import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TIER_META: Record<string, { label: string; className: string }> = {
  frontier: {
    label: "Frontier",
    className: "bg-chart-1/15 text-chart-1 [border-color:var(--chart-1)]",
  },
  research: {
    label: "Research",
    className: "bg-chart-2/15 text-chart-2 [border-color:var(--chart-2)]",
  },
  routine: {
    label: "Routine",
    className: "bg-chart-3/15 text-chart-3 [border-color:var(--chart-3)]",
  },
};

export function tierLabel(tier?: string | null): string {
  if (!tier) return "—";
  return TIER_META[tier]?.label ?? tier;
}

export function TierBadge({
  tier,
  className,
}: {
  tier?: string | null;
  className?: string;
}) {
  if (!tier) return <span className="text-muted-foreground">—</span>;
  const meta = TIER_META[tier];
  return (
    <Badge
      variant="outline"
      className={cn("border", meta?.className, className)}
    >
      {meta?.label ?? tier}
    </Badge>
  );
}
