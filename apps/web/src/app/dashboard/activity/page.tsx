import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "Tool Call Logs | Normal" };

export default function ActivityPage() {
  return (
    <DashboardRoute
      description="Review how MCP Clients used your WhatsApp access."
      title="Tool Call Logs"
    />
  );
}
