import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Activity, Building2, Cpu, Users, Layers, ShieldCheck, Wallet, Waypoints, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { DateRangeSelector } from "./date-range-selector";

const navItems = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/departments", label: "Departments", icon: Building2 },
  { href: "/employees", label: "Employees", icon: Users },
  { href: "/tiers", label: "Access Tiers", icon: ShieldCheck },
  { href: "/models", label: "Models", icon: Layers },
  { href: "/agents", label: "Agents", icon: Cpu },
  { href: "/traces", label: "Traces", icon: Waypoints },
  { href: "/budgets", label: "Budgets", icon: Wallet },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  
  // Quick dark mode toggle
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-64 border-r border-border bg-card flex flex-col shrink-0">
        <div className="p-6 flex items-center gap-3 border-b border-border">
          <div className="size-8 rounded bg-primary flex items-center justify-center text-primary-foreground">
            <Activity className="size-5" />
          </div>
          <span className="font-bold tracking-tight text-lg">AgentOps</span>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => setIsDark(!isDark)}>
            {isDark ? <Sun className="size-4 mr-2" /> : <Moon className="size-4 mr-2" />}
            {isDark ? 'Light Mode' : 'Dark Mode'}
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-background flex flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-end gap-3 border-b border-border bg-background/80 backdrop-blur px-6 py-3">
          <span className="mr-auto text-sm font-medium text-muted-foreground">Reporting window</span>
          <DateRangeSelector />
        </header>
        <div className="flex-1">{children}</div>
      </main>
    </div>
  );
}
