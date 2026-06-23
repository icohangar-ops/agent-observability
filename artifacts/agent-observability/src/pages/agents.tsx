import { useListAgents } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatNumber } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Search } from "lucide-react";

export default function Agents() {
  const { data: agents, isLoading } = useListAgents();
  const [search, setSearch] = useState("");

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const filteredAgents = agents?.filter((a) => 
    a.name.toLowerCase().includes(search.toLowerCase()) || 
    a.employeeName.toLowerCase().includes(search.toLowerCase()) ||
    a.departmentName.toLowerCase().includes(search.toLowerCase()) ||
    a.modelName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Agent Inventory</h1>
        <p className="text-muted-foreground">Detailed listing of all active and historical agents.</p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input 
          placeholder="Search agents, employees, departments, models..." 
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAgents?.map((agent) => (
              <TableRow key={agent.id} className="group transition-colors">
                <TableCell>
                  <div className="font-medium">
                    <Link href={`/agents/${agent.id}`} className="hover:underline hover:text-primary">
                      {agent.name}
                    </Link>
                  </div>
                  <div className="text-xs text-muted-foreground max-w-[200px] truncate" title={agent.purpose}>{agent.purpose}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={agent.status === 'active' ? 'default' : agent.status === 'idle' ? 'outline' : 'secondary'}>
                    {agent.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Link href={`/employees/${agent.employeeId}`} className="text-sm hover:underline hover:text-primary">
                    {agent.employeeName}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link href={`/departments/${agent.departmentId}`} className="text-sm hover:underline hover:text-primary">
                    {agent.departmentName}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{agent.modelName}</div>
                </TableCell>
                <TableCell className="text-right font-mono">{formatUSD(agent.cost)}</TableCell>
                <TableCell className="text-right font-mono">{formatTokens(agent.tokens)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(agent.runCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
