import { useGetDepartment } from "@workspace/api-client-react";
import { useDateRange } from "@/lib/date-range";
import { formatUSD, formatTokens, formatNumber, formatPercent } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { BudgetBadge } from "@/components/budget-badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Link, useParams } from "wouter";

export default function DepartmentDetail() {
  const { departmentId } = useParams<{ departmentId: string }>();
  const { params } = useDateRange();
  const { data: dept, isLoading } = useGetDepartment(departmentId || "", params, {
    query: { enabled: !!departmentId, queryKey: ["department", departmentId, params] }
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

  if (!dept) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <Link href="/departments"><BreadcrumbLink asChild><span>Departments</span></BreadcrumbLink></Link>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{dept.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{dept.name}</h1>
        {dept.budget && <BudgetBadge status={dept.budget.status} showOk />}
      </div>

      {dept.budget && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <div className="text-xs text-muted-foreground uppercase font-semibold">
                Monthly Budget{dept.budget.period ? ` · ${dept.budget.period}` : ""}
              </div>
              <div className="text-sm font-mono">
                {formatUSD(dept.budget.spend)} <span className="text-muted-foreground">/ {formatUSD(dept.budget.amount)}</span>
              </div>
            </div>
            <div className="h-2.5 w-full bg-secondary rounded-full overflow-hidden">
              <div
                className={`h-full ${dept.budget.status === "over" ? "bg-destructive" : dept.budget.status === "warning" ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min(dept.budget.utilization * 100, 100)}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(dept.budget.utilization)} of monthly budget used
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Cost</div>
            <div className="text-2xl font-bold font-mono">{formatUSD(dept.cost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Total Tokens</div>
            <div className="text-2xl font-bold font-mono">{formatTokens(dept.tokens)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Agents</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(dept.agentCount)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground uppercase font-semibold mb-1">Employees</div>
            <div className="text-2xl font-bold font-mono">{formatNumber(dept.employeeCount)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Employees</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Agents</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dept.employees.map((emp) => (
                  <TableRow key={emp.id}>
                    <TableCell className="font-medium">
                      <Link href={`/employees/${emp.id}`} className="hover:underline hover:text-primary">
                        {emp.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{emp.role}</TableCell>
                    <TableCell className="text-right font-mono">{formatUSD(emp.cost)}</TableCell>
                    <TableCell className="text-right font-mono">{formatTokens(emp.tokens)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(emp.agentCount)}</TableCell>
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
              {dept.modelBreakdown.map((model, i) => (
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

          {dept.modelBudgets && dept.modelBudgets.length > 0 && (
            <>
              <h2 className="text-xl font-semibold tracking-tight">Per-Model Budgets</h2>
              <Card>
                <div className="p-0">
                  {dept.modelBudgets.map((b, i) => (
                    <div key={b.id} className={`p-4 flex flex-col gap-2 ${i !== 0 ? 'border-t border-border' : ''}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium">{b.modelName}</div>
                        <BudgetBadge status={b.status} showOk />
                      </div>
                      <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full ${b.status === "over" ? "bg-destructive" : b.status === "warning" ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${Math.min(b.utilization * 100, 100)}%` }}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {formatUSD(b.spend)} / {formatUSD(b.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
