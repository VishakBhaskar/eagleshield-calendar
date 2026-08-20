import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CalendarApp } from "./calendar-app";
import { actorForSessionToken, bootstrapMasterAdmin, SESSION_COOKIE } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Eagle Shield Calendar",
  description:
    "Manage Eagle Shield appointments, territory capacity, reps, and scheduling.",
};

export const dynamic = "force-dynamic";

export default async function Home() {
  await bootstrapMasterAdmin();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  if (!(await actorForSessionToken(token))) redirect("/login");
  return <CalendarApp />;
}
