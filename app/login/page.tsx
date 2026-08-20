import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { actorForSessionToken, bootstrapMasterAdmin, SESSION_COOKIE } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await bootstrapMasterAdmin();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  if (await actorForSessionToken(token)) redirect("/");
  return (
    <main className="login-shell">
      <section className="login-window" aria-label="Eagle Shield staff sign in">
        <aside className="login-overview">
          <div className="login-brand login-brand-inverse">
            <div className="shield" aria-hidden="true" />
            <div>
              <div className="login-brand-title">Eagle Shield Calendar</div>
              <div className="sub">Appointment Operations</div>
            </div>
          </div>

          <div className="login-overview-copy">
            <div className="login-eyebrow">Operations workspace</div>
            <h1>One calendar for every field appointment.</h1>
            <p>
              Coordinate capacity, assignments, and customer visits across both
              Eagle Shield locations.
            </p>
          </div>

          <div className="login-locations" aria-label="Managed locations">
            <div className="login-location">
              <span className="login-location-mark sac" aria-hidden="true" />
              <span><b>Sacramento</b><small>2 appointments per time slot</small></span>
            </div>
            <div className="login-location">
              <span className="login-location-mark eb" aria-hidden="true" />
              <span><b>East Bay</b><small>1 appointment per time slot</small></span>
            </div>
          </div>

          <div className="login-private-note">
            <span aria-hidden="true">✓</span>
            Private workspace for authorized Eagle Shield staff
          </div>
        </aside>

        <div className="login-entry">
          <LoginForm />
        </div>
      </section>
      <p className="login-footer">Eagle Shield Pest Control · Internal appointment management</p>
    </main>
  );
}
