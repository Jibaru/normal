import type { Metadata } from "next";
import { connection } from "next/server";
import { getPersonalAccountConfiguration } from "../personal-account-configuration";
import { DashboardExperience } from "./dashboard-experience";

export const metadata: Metadata = {
  title: "Dashboard | Normal",
  description: "Manage your Personal Account and WhatsApp Connections.",
  robots: { follow: false, index: false },
};

export default async function DashboardPage() {
  await connection();
  return (
    <DashboardExperience configuration={getPersonalAccountConfiguration()} />
  );
}
