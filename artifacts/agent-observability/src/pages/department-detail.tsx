import { useGetDepartment } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Link, useParams } from "wouter";

export default function DepartmentDetail() {
  const { departmentId } = useParams<{ departmentId: string }>();
  const { data: dept, isLoading } = useGetDepartment(departmentId || "", {
    query: { enabled: !!departmentId, queryKey: ["department", departmentId] }
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

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{dept.name}</h1>
      </div>

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
        </div>
      </div>
    </div>
  );
}
