import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { DateRangeProvider } from "@/lib/date-range";
import NotFound from "@/pages/not-found";

import Overview from "@/pages/overview";
import Departments from "@/pages/departments";
import DepartmentDetail from "@/pages/department-detail";
import Employees from "@/pages/employees";
import EmployeeDetail from "@/pages/employee-detail";
import Tiers from "@/pages/tiers";
import Models from "@/pages/models";
import Agents from "@/pages/agents";
import AgentDetail from "@/pages/agent-detail";
import Traces from "@/pages/traces";
import Budgets from "@/pages/budgets";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/departments" component={Departments} />
        <Route path="/departments/:departmentId" component={DepartmentDetail} />
        <Route path="/employees" component={Employees} />
        <Route path="/employees/:employeeId" component={EmployeeDetail} />
        <Route path="/tiers" component={Tiers} />
        <Route path="/models" component={Models} />
        <Route path="/agents" component={Agents} />
        <Route path="/agents/:agentId" component={AgentDetail} />
        <Route path="/traces" component={Traces} />
        <Route path="/budgets" component={Budgets} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <DateRangeProvider>
            <Router />
          </DateRangeProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
