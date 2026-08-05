import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "Settings | Normal" };

export default function SettingsPage() {
  return (
    <DashboardRoute
      description="Manage Personal Account lifecycle settings."
      title="Settings"
    />
  );
}
