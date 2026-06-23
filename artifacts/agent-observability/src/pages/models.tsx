import { useListModels } from "@workspace/api-client-react";
import { formatUSD, formatTokens, formatPercent, formatNumber } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Models() {
  const { data: models, isLoading } = useListModels();

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
        <h1 className="text-3xl font-bold tracking-tight">Models</h1>
        <p className="text-muted-foreground">Foundation models driving agent activity and their cost impact.</p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Pricing (1M In/Out)</TableHead>
              <TableHead className="text-right">Cost Share</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Agents</TableHead>
              <TableHead className="text-right">Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models?.map((model) => (
              <TableRow key={model.id} className="group transition-colors">
                <TableCell>
                  <div className="font-medium">{model.name}</div>
                  <div className="text-xs text-muted-foreground">{model.provider}</div>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {formatUSD(model.inputPricePerMillion)} / {formatUSD(model.outputPricePerMillion)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-muted-foreground text-xs">{formatPercent(model.costShare)}</span>
                    <div className="w-16 h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-chart-4" style={{ width: `${model.costShare * 100}%` }} />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">{formatUSD(model.cost)}</TableCell>
                <TableCell className="text-right font-mono">{formatTokens(model.tokens)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(model.agentCount)}</TableCell>
                <TableCell className="text-right font-mono">{formatNumber(model.runCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
