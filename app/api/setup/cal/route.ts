import { requireActor } from "@/lib/auth";
import { integrationStatus, validateCalConfiguration } from "@/lib/cal";
import { writeAudit } from "@/db/runtime";

export async function POST(request: Request) {
  const auth = await requireActor(request, ["master_admin"]);
  if (auth.response) return auth.response;
  const integration = integrationStatus();
  if (integration.mode !== "live" || !integration.healthy) {
    return Response.json({ error: integration.message }, { status: 409 });
  }
  const locations = await validateCalConfiguration();
  const healthy = locations.every((location) => location.healthy);
  const correlationId = crypto.randomUUID();
  await writeAudit({
    actorId: auth.actor.id,
    actorEmail: auth.actor.email,
    action: "cal.validated",
    entityType: "integration",
    entityId: "cal.com",
    detail: { locations },
    correlationId,
  });
  return Response.json({ healthy, locations, correlationId }, { status: healthy ? 200 : 409 });
}
