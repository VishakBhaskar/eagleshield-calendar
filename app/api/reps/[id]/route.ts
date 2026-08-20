import { ensureDatabase, writeAudit } from "@/db/runtime";
import { hashPassword, requireActor } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireActor(request, ["master_admin"]);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const payload = (await request.json().catch(() => null)) as {
    active?: boolean;
    role?: UserRole;
    password?: string;
    sacramentoEligible?: boolean;
    eastBayEligible?: boolean;
  } | null;
  if (!payload) return Response.json({ error: "Invalid request" }, { status: 400 });
  const db = await ensureDatabase();
  const current = await db
    .prepare(
      `SELECT u.id,u.active,u.role,r.sacramento_eligible,r.east_bay_eligible
       FROM users u JOIN reps r ON r.user_id=u.id WHERE u.id=?`,
    )
    .bind(id)
    .first<{
      id: string;
      active: number;
      role: UserRole;
      sacramento_eligible: number;
      east_bay_eligible: number;
    }>();
  if (!current) return Response.json({ error: "User not found" }, { status: 404 });
  const active = payload.active ?? Boolean(current.active);
  const role = payload.role ?? current.role;
  const sac = payload.sacramentoEligible ?? Boolean(current.sacramento_eligible);
  const eb = payload.eastBayEligible ?? Boolean(current.east_bay_eligible);
  if (auth.actor.id === id && !active) {
    return Response.json({ error: "You cannot deactivate your own account" }, { status: 400 });
  }
  if (active && !sac && !eb) {
    return Response.json({ error: "An active user needs at least one eligible location" }, { status: 400 });
  }
  if (!(["master_admin", "manager", "staff"] as string[]).includes(role)) {
    return Response.json({ error: "Unknown account role" }, { status: 400 });
  }
  if (current.role === "master_admin" && role !== "master_admin") {
    const remaining = await db
      .prepare("SELECT COUNT(*)::int AS count FROM users WHERE role='master_admin' AND active=1 AND id!=?")
      .bind(id)
      .first<{ count: number }>();
    if (!Number(remaining?.count ?? 0)) {
      return Response.json({ error: "At least one active master admin is required" }, { status: 400 });
    }
  }
  if (payload.password !== undefined && payload.password.length < 12) {
    return Response.json({ error: "Passwords must contain at least 12 characters" }, { status: 400 });
  }
  const passwordHash = payload.password ? await hashPassword(payload.password) : null;
  await db.batch([
    db
      .prepare(
        `UPDATE users SET active=?,role=?,password_hash=COALESCE(?,password_hash),
         updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      )
      .bind(active ? 1 : 0, role, passwordHash, id),
    db
      .prepare(
        `UPDATE reps SET active=?,sacramento_eligible=?,east_bay_eligible=?,
         updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
      )
      .bind(active ? 1 : 0, sac ? 1 : 0, eb ? 1 : 0, id),
    ...(active
      ? []
      : [db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id)]),
  ]);
  await writeAudit({
    actorId: auth.actor.id,
    actorEmail: auth.actor.email,
    action: "user.updated",
    entityType: "user",
    entityId: id,
    detail: { active, role, sacramentoEligible: sac, eastBayEligible: eb, passwordReset: Boolean(passwordHash) },
    correlationId: crypto.randomUUID(),
  });
  return Response.json({ repId: id, active, role, sacramentoEligible: sac, eastBayEligible: eb });
}
