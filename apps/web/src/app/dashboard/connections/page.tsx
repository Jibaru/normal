import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "WhatsApp Connections | Normal" };

export default function ConnectionsPage() {
  return (
    <DashboardRoute
      description="Add, reconnect, and manage your WhatsApp Connections."
      title="WhatsApp Connections"
    />
  );
}
