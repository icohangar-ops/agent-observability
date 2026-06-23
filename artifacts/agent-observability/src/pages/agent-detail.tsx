import { useGetAgent } from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatUSD, formatTokens, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Link, useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/tier-badge";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { format } from "date-fns";

export default function AgentDetail() {
  const { agentId } = useParams<{ agentId: string }>();
  const { params } = useDateRange();
  const { data: agent, isLoading } = useGetAgent(agentId || "", params, {
    query: { enabled: !!agentId, queryKey: ["agent", agentId, params] }
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!agent) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <Link href="/agents"><BreadcrumbLink asChild><span>Agents</span></BreadcrumbLink></Link>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{agent.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
            <Badge variant={agent.status === 'active' ? 'default' : agent.status === 'idle' ? 'outline' : 'secondary'} className="h-6">
              {agent.status}
            </Badge>
            <TierBadge tier={agent.modelTier} className="h-6" />
          </div>
          <p className="text-muted-foreground max-w-2xl">{agent.purpose}</p>
          <div className="text-sm text-muted-foreground">
            Model: <span className="text-foreground font-medium">{agent.modelName}</span>{" "}
            <span className="text-xs">({agent.provider})</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground md:text-right">
          <div>Created: {format(new Date(agent.createdAt), "MMM d, yyyy")}</div>
          <div>Last active: {format(new Date(agent.lastActiveAt), "MMM d, yyyy")}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Cost</div>
            <div className="text-2xl font-bold font-mono">{formatUSD(agent.cost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Tokens</div>
            <div className="text-2xl font-bold font-mono">{formatTokens(agent.tokens)}</div>
            <div className="text-xs text-muted-foreground mt-1 font-mono flex justify-between">
              <span>I: {formatTokens(agent.inputTokens)}</span>
              <span>O: {formatTokens(agent.outputTokens)}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Runs</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(agent.runCount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Attribution</div>
            <div className="flex flex-col gap-1 text-sm font-medium mt-1">
              <Link href={`/employees/${agent.employeeId}`} className="hover:underline hover:text-primary">{agent.employeeName}</Link>
              <Link href={`/departments/${agent.departmentId}`} className="hover:underline hover:text-primary text-muted-foreground">{agent.departmentName}</Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage Trends</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[250px] w-full">
            {agent.trends && agent.trends.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={agent.trends}>
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

      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead className="text-right">Input Tokens</TableHead>
              <TableHead className="text-right">Output Tokens</TableHead>
              <TableHead className="text-right">Total Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agent.recentRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="text-muted-foreground font-mono text-sm">
                  {format(new Date(run.timestamp), "MMM d, HH:mm:ss")}
                </TableCell>
                <TableCell className="text-right font-mono">{formatTokens(run.inputTokens, false)}</TableCell>
                <TableCell className="text-right font-mono">{formatTokens(run.outputTokens, false)}</TableCell>
                <TableCell className="text-right font-mono font-medium">{formatTokens(run.tokens, false)}</TableCell>
                <TableCell className="text-right font-mono font-medium text-primary">{formatUSD(run.cost, false)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
