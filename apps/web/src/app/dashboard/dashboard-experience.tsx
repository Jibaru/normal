"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import {
  Activity,
  Cable,
  LayoutDashboard,
  MessageCircleMore,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PublicBoundaryJourney } from "../public-boundary-journey";

type Configuration = Parameters<typeof PublicBoundaryJourney>[0];

const navigation = [
  { icon: LayoutDashboard, label: "Overview" },
  { icon: MessageCircleMore, label: "WhatsApp Connections" },
  { icon: Cable, label: "MCP Authorizations" },
  { icon: Activity, label: "Tool Call Logs" },
] as const;

export function DashboardExperience({
  configuration,
}: {
  readonly configuration: Configuration | null;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();

  if (!isLoaded) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground">
          Checking sign in status…
        </p>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <section className="w-full max-w-md rounded-2xl bg-background p-8 shadow-sm ring-1 ring-border">
          <Link className="wordmark" href="/">
            Normal<span aria-hidden="true">.</span>
          </Link>
          <h1 className="mt-10 text-3xl font-semibold tracking-tight">
            Sign in to your dashboard
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Your dashboard is only available to authenticated Users.
          </p>
          <Button className="mt-8 w-full" onClick={() => clerk.openSignIn()}>
            Sign in
          </Button>
        </section>
      </main>
    );
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="bg-muted/30">
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/dashboard" />}
                  size="lg"
                  tooltip="Normal"
                >
                  <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                    N
                  </span>
                  <span className="font-semibold tracking-tight">Normal.</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Personal Account</SidebarGroupLabel>
              <SidebarGroupContent>
                <nav aria-label="Dashboard navigation">
                  <SidebarMenu>
                    {navigation.map((item, index) => (
                      <SidebarMenuItem key={item.label}>
                        <SidebarMenuButton
                          isActive={index === 0}
                          render={<Link href="/dashboard#dashboard-content" />}
                          tooltip={item.label}
                        >
                          <item.icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/dashboard#dashboard-content" />}
                  tooltip="Settings"
                >
                  <Settings aria-hidden="true" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarGroupLabel>
              <ShieldCheck aria-hidden="true" />
              Private beta
            </SidebarGroupLabel>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset className="bg-muted/30">
          <div className="flex h-14 items-center border-b bg-background px-4 md:hidden">
            <SidebarTrigger aria-label="Open dashboard navigation" />
          </div>
          <div className="dashboard-main" id="dashboard-content">
            <header className="dashboard-header">
              <div>
                <p className="section-kicker">Personal Account</p>
                <h1>Dashboard</h1>
                <p className="dashboard-subtitle">
                  Manage your WhatsApp Connections and MCP Client access.
                </p>
              </div>
              <Button
                onClick={() => clerk.signOut({ redirectUrl: "/" })}
                variant="outline"
              >
                Sign out
              </Button>
            </header>

            <section className="dashboard-content-card">
              {configuration === null ? (
                <p className="text-sm text-muted-foreground">
                  Your Personal Account is temporarily unavailable.
                </p>
              ) : (
                <PublicBoundaryJourney {...configuration} />
              )}
            </section>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
