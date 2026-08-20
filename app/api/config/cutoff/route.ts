import { ensureDatabase, writeAudit } from "@/db/runtime";
import { requireActor } from "@/lib/auth";

export async function PATCH(request: Request) {
  const auth = await requireActor(request, ["master_admin", "manager"]);
  if (auth.response) return auth.response;
  const payload = (await request.json().catch(() => null)) as {
    enabled?: boolean;
  } | null;
  if (typeof payload?.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES ('cutoff_on',?,CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
    )
    .bind(String(payload.enabled))
    .run();
  const correlationId = crypto.randomUUID();
  await writeAudit({
    actorId: auth.actor.id,
    actorEmail: auth.actor.email,
    action: "cutoff.updated",
    entityType: "settings",
    entityId: "cutoff_on",
    detail: { enabled: payload.enabled },
    correlationId,
  });
  return Response.json({ enabled: payload.enabled, correlationId });
}
