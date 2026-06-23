import { useListTiers } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatPercent, formatNumber } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TierBadge } from "@/components/tier-badge";

const TIER_DESCRIPTIONS: Record<string, string> = {
  frontier:
    "Top-end models (e.g. Claude, GPT-4o) reserved for complex analysis and high-stakes work.",
  research:
    "Specialized research models (e.g. Perplexity, Gemini) for deep research and investigation.",
  routine:
    "Cost-efficient model routers (e.g. OpenRouter, Baseten) for routine, high-volume work.",
};

export default function Tiers() {
  const { data: tiers, isLoading } = useListTiers();

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const totalCost = tiers?.reduce((s, t) => s + t.cost, 0) ?? 0;
  const totalTokens = tiers?.reduce((s, t) => s + t.tokens, 0) ?? 0;
  const totalEmployees = tiers?.reduce((s, t) => s + t.employeeCount, 0) ?? 0;
  const totalAgents = tiers?.reduce((s, t) => s + t.agentCount, 0) ?? 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Access Tiers</h1>
        <p className="text-muted-foreground">
          Governed model access by tier. Track token spend across frontier, research, and routine
          tiers to keep AI costs aligned with the work each team does.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Spend</div>
            <div className="text-2xl font-bold font-mono">{formatUSD(totalCost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Tokens</div>
            <div className="text-2xl font-bold font-mono">{formatTokens(totalTokens)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Employees Governed</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(totalEmployees)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Agents</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(totalAgents)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        {tiers?.map((tier) => (
          <Card key={tier.tier}>
            <CardContent className="p-6 space-y-5">
              <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <TierBadge tier={tier.tier} />
                    <span className="text-sm text-muted-foreground">
                      {tier.modelCount} {tier.modelCount === 1 ? "model" : "models"} ·{" "}
                      {tier.employeeCount} {tier.employeeCount === 1 ? "employee" : "employees"} ·{" "}
                      {tier.agentCount} {tier.agentCount === 1 ? "agent" : "agents"}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground max-w-2xl">
                    {TIER_DESCRIPTIONS[tier.tier] ?? ""}
                  </p>
                </div>
                <div className="md:text-right shrink-0">
                  <div className="text-2xl font-bold font-mono">{formatUSD(tier.cost)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatPercent(tier.costShare)} of total spend · {formatTokens(tier.tokens)} tokens
                  </div>
                </div>
              </div>

              <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-chart-4"
                  style={{ width: `${tier.costShare * 100}%` }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {tier.models.map((model) => (
                  <div
                    key={model.modelId}
                    className="rounded-md border border-border p-3 flex items-center justify-between"
                  >
                    <div>
                      <div className="font-medium text-sm">{model.modelName}</div>
                      <div className="text-xs text-muted-foreground">{model.provider}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm font-medium">{formatUSD(model.cost)}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {formatTokens(model.tokens)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
