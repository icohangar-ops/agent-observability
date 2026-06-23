import { useGetOverview, useGetTrends, useListDepartments, useListModels } from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatUSD, formatTokens, formatNumber, formatPercent } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export default function Overview() {
  const { params } = useDateRange();
  const { data: overview, isLoading: isOverviewLoading } = useGetOverview(params);
  const { data: trends, isLoading: isTrendsLoading } = useGetTrends(params);
  const { data: departments, isLoading: isDeptsLoading } = useListDepartments(params);
  const { data: models, isLoading: isModelsLoading } = useListModels(params);

  if (isOverviewLoading || isDeptsLoading || isModelsLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (!overview) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Organization Overview</h1>
        <p className="text-muted-foreground">High-level summary of AI agent spend and token consumption.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-primary text-primary-foreground border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-primary-foreground/80 font-medium">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-bold font-mono tracking-tighter">
              {formatUSD(overview.totalCost, true)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card shadow-sm border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground font-medium">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-bold font-mono tracking-tighter text-foreground">
              {formatTokens(overview.totalTokens)}
            </div>
            <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
              <span>In: {formatTokens(overview.totalInputTokens)}</span>
              <span>Out: {formatTokens(overview.totalOutputTokens)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Active Agents", value: `${overview.activeAgentCount} / ${overview.agentCount}` },
          { label: "Total Runs", value: formatNumber(overview.runCount) },
          { label: "Employees", value: formatNumber(overview.employeeCount) },
          { label: "Departments", value: formatNumber(overview.departmentCount) },
          { label: "Models Used", value: formatNumber(overview.modelCount) },
          { label: "Avg Cost / Agent", value: formatUSD(overview.avgCostPerAgent) },
          { label: "Top Dept", value: overview.topDepartment || "N/A" },
          { label: "Top Model", value: overview.topModel || "N/A" },
        ].map((kpi, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">{kpi.label}</div>
              <div className="text-xl font-medium">{kpi.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost & Token Trends</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] w-full">
            {isTrendsLoading ? (
              <Skeleton className="h-full w-full" />
            ) : trends && trends.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} />
                  <YAxis yAxisId="right" orientation="right" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => formatTokens(val)} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 'var(--radius)' }}
                    labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                  />
                  <Line yAxisId="left" type="monotone" dataKey="cost" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="tokens" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">No trend data available</div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Top Departments</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {departments?.slice(0, 5).map((dept) => (
                <div key={dept.id} className="p-4 flex items-center justify-between group hover:bg-muted/50 transition-colors">
                  <div className="flex-1">
                    <Link href={`/departments/${dept.id}`} className="font-medium hover:underline hover:text-primary">
                      {dept.name}
                    </Link>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">{formatPercent(dept.costShare)}</span>
                      <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${dept.costShare * 100}%` }} />
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-medium">{formatUSD(dept.cost)}</div>
                    <div className="text-xs text-muted-foreground font-mono">{formatTokens(dept.tokens)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-border">
              <Link href="/departments" className="text-sm font-medium text-primary hover:underline">
                View all departments &rarr;
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top Models</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {models?.slice(0, 5).map((model) => (
                <div key={model.id} className="p-4 flex items-center justify-between group hover:bg-muted/50 transition-colors">
                  <div className="flex-1">
                    <div className="font-medium">{model.name}</div>
                    <div className="text-xs text-muted-foreground">{model.provider}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-medium">{formatUSD(model.cost)}</div>
                    <div className="text-xs text-muted-foreground font-mono">{formatTokens(model.tokens)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-border">
              <Link href="/models" className="text-sm font-medium text-primary hover:underline">
                View all models &rarr;
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
