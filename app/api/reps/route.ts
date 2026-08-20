import { ensureDatabase, writeAudit } from "@/db/runtime";
import { hashPassword, requireActor } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

type UserInput = {
  name?: string;
  email?: string;
  password?: string;
  role?: UserRole;
  sacramentoEligible?: boolean;
  eastBayEligible?: boolean;
};

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

export async function POST(request: Request) {
  const auth = await requireActor(request, ["master_admin"]);
  if (auth.response) return auth.response;
  const payload = (await request.json().catch(() => null)) as UserInput | null;
  const name = payload?.name?.trim() ?? "";
  const email = payload?.email?.trim().toLowerCase() ?? "";
  const password = payload?.password ?? "";
  const role = payload?.role ?? "staff";
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Name and a valid email are required" }, { status: 400 });
  }
  if (password.length < 12) {
    return Response.json({ error: "Passwords must contain at least 12 characters" }, { status: 400 });
  }
  if (!(["master_admin", "manager", "staff"] as string[]).includes(role)) {
    return Response.json({ error: "Unknown account role" }, { status: 400 });
  }
  if (!payload?.sacramentoEligible && !payload?.eastBayEligible) {
    return Response.json({ error: "Select at least one location" }, { status: 400 });
  }
  const id = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const passwordHash = await hashPassword(password);
    const db = await ensureDatabase();
    await db.batch([
      db
        .prepare(
          `INSERT INTO users
           (id,name,email,password_hash,role,active,must_change_password)
           VALUES (?,?,?,?,?,1,0)`,
        )
        .bind(id, name, email, passwordHash, role),
      db
        .prepare(
          `INSERT INTO reps
           (id,user_id,name,email,initials,sacramento_eligible,east_bay_eligible,active)
           VALUES (?,?,?,?,?,?,?,1)`,
        )
        .bind(
          id,
          id,
          name,
          email,
          initials(name),
          payload.sacramentoEligible ? 1 : 0,
          payload.eastBayEligible ? 1 : 0,
        ),
    ]);
    await writeAudit({
      actorId: auth.actor.id,
      actorEmail: auth.actor.email,
      action: "user.created",
      entityType: "user",
      entityId: id,
      detail: {
        name,
        email,
        role,
        sacramentoEligible: Boolean(payload.sacramentoEligible),
        eastBayEligible: Boolean(payload.eastBayEligible),
      },
      correlationId: id,
    });
    return Response.json({ repId: id, userId: id }, { status: 201 });
  } catch (error) {
    const duplicate = error instanceof Error && /unique|duplicate/i.test(error.message);
    return Response.json(
      { error: duplicate ? "A user with this email already exists" : "User could not be added" },
      { status: duplicate ? 409 : 500 },
    );
  }
}
