import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "MCP Authorizations | Normal" };

export default function AuthorizationsPage() {
  return (
    <DashboardRoute
      description="Review and revoke the MCP Clients that can access WhatsApp."
      title="MCP Authorizations"
    />
  );
}
