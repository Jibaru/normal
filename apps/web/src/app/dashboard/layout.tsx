import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getPersonalAccountConfiguration } from "../personal-account-configuration";
import { DashboardShell } from "./dashboard-shell";

export default async function DashboardLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  await connection();
  const canonicalWebOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN;
  if (process.env.NODE_ENV === "development" && canonicalWebOrigin) {
    const requestHeaders = await headers();
    const host =
      requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
    const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
    const requestOrigin = host === null ? null : `${protocol}://${host}`;

    if (requestOrigin !== canonicalWebOrigin) {
      redirect(`${canonicalWebOrigin}/dashboard`);
    }
  }

  return (
    <DashboardShell configuration={getPersonalAccountConfiguration()}>
      {children}
    </DashboardShell>
  );
}
