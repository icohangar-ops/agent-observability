import { useListEmployees } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatNumber } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

export default function Employees() {
  const { data: employees, isLoading } = useListEmployees();

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
        <h1 className="text-3xl font-bold tracking-tight">Employees</h1>
        <p className="text-muted-foreground">AI agent spend and usage attributed to individual employees.</p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Agents</TableHead>
              <TableHead className="text-right">Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees?.map((emp) => (
              <TableRow key={emp.id} className="group transition-colors">
                <TableCell>
                  <div className="font-medium">
                    <Link href={`/employees/${emp.id}`} className="hover:underline hover:text-primary">
                      {emp.name}
                    </Link>
                  </div>
                  <div className="text-xs text-muted-foreground">{emp.role}</div>
                </TableCell>
                <TableCell>
                  <Link href={`/departments/${emp.departmentId}`} className="text-sm hover:underline hover:text-primary">
                    {emp.departmentName}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-mono">{formatUSD(emp.cost)}</TableCell>
                <TableCell className="text-right font-mono">{formatTokens(emp.tokens)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(emp.agentCount)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(emp.runCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
