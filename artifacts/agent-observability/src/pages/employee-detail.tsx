import { useGetEmployee } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatNumber } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Link, useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/tier-badge";

export default function EmployeeDetail() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const { data: emp, isLoading } = useGetEmployee(employeeId || "", {
    query: { enabled: !!employeeId, queryKey: ["employee", employeeId] }
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

  if (!emp) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <Link href="/employees"><BreadcrumbLink asChild><span>Employees</span></BreadcrumbLink></Link>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{emp.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{emp.name}</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{emp.role}</span>
          <span>•</span>
          <Link href={`/departments/${emp.departmentId}`} className="hover:underline hover:text-primary">
            {emp.departmentName}
          </Link>
          <span>•</span>
          <span className="flex items-center gap-1.5">
            Access tier <TierBadge tier={emp.accessTier} />
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Cost</div>
            <div className="text-2xl font-bold font-mono">{formatUSD(emp.cost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Tokens</div>
            <div className="text-2xl font-bold font-mono">{formatTokens(emp.tokens)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Agents Launched</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(emp.agentCount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Runs</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(emp.runCount)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Agents</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emp.agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">
                      <Link href={`/agents/${agent.id}`} className="hover:underline hover:text-primary">
                        {agent.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{agent.modelName}</TableCell>
                    <TableCell>
                      <Badge variant={agent.status === 'active' ? 'default' : 'secondary'}>
                        {agent.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatUSD(agent.cost)}</TableCell>
                    <TableCell className="text-right font-mono">{formatTokens(agent.tokens)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Model Breakdown</h2>
          <Card>
            <div className="p-0">
              {emp.modelBreakdown.map((model, i) => (
                <div key={model.modelId} className={`p-4 flex items-center justify-between ${i !== 0 ? 'border-t border-border' : ''}`}>
                  <div>
                    <div className="font-medium">{model.modelName}</div>
                    <div className="text-xs text-muted-foreground">{model.provider}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-medium">{formatUSD(model.cost)}</div>
                    <div className="text-xs text-muted-foreground font-mono">{formatTokens(model.tokens)}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
