import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { actorForSessionToken, bootstrapMasterAdmin, SESSION_COOKIE } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await bootstrapMasterAdmin();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  if (await actorForSessionToken(token)) redirect("/");
  return <main className="login-shell"><LoginForm /></main>;
}
