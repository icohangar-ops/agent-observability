import { useListDepartments } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatPercent, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

export default function Departments() {
  const { data: departments, isLoading } = useListDepartments();

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Departments</h1>
        <p className="text-muted-foreground">Cost and usage breakdown across the organization.</p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Cost Share</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Agents</TableHead>
              <TableHead className="text-right">Employees</TableHead>
              <TableHead className="text-right">Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments?.map((dept) => (
              <TableRow key={dept.id} className="group transition-colors">
                <TableCell className="font-medium">
                  <Link href={`/departments/${dept.id}`} className="hover:underline hover:text-primary">
                    {dept.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-muted-foreground text-xs">{formatPercent(dept.costShare)}</span>
                    <div className="w-16 h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${dept.costShare * 100}%` }} />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{formatUSD(dept.cost)}</TableCell>
                <TableCell className="text-right font-mono">{formatTokens(dept.tokens)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(dept.agentCount)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(dept.employeeCount)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(dept.runCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
