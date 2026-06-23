import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";

import Overview from "@/pages/overview";
import Departments from "@/pages/departments";
import DepartmentDetail from "@/pages/department-detail";
import Employees from "@/pages/employees";
import EmployeeDetail from "@/pages/employee-detail";
import Models from "@/pages/models";
import Agents from "@/pages/agents";
import AgentDetail from "@/pages/agent-detail";

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
        <Route path="/models" component={Models} />
        <Route path="/agents" component={Agents} />
        <Route path="/agents/:agentId" component={AgentDetail} />
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
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
