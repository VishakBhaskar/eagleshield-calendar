import { readSnapshot } from "@/db/runtime";
import { getProviderAvailability, integrationStatus } from "@/lib/cal";
import { requireActor } from "@/lib/auth";
import { addDays } from "@/lib/domain.mjs";
import type { ProviderAvailability } from "@/lib/types";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const auth = await requireActor(request, ["master_admin", "manager", "staff"]);
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ?? today;
  const to = url.searchParams.get("to") ?? from;
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) {
    return Response.json({ error: "Invalid calendar range" }, { status: 400 });
  }
  const rangeDays =
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
    86_400_000;
  if (rangeDays > 370) {
    return Response.json({ error: "Calendar range is too large" }, { status: 400 });
  }
  const availabilityFrom = url.searchParams.get("availabilityFrom") ?? from;
  const availabilityTo = url.searchParams.get("availabilityTo") ??
    (rangeDays <= 62 ? to : addDays(from, 41));
  if (
    !datePattern.test(availabilityFrom) ||
    !datePattern.test(availabilityTo) ||
    availabilityFrom > availabilityTo ||
    availabilityFrom < from ||
    availabilityTo > to
  ) {
    return Response.json({ error: "Invalid availability range" }, { status: 400 });
  }
  const availabilityDays =
    (new Date(`${availabilityTo}T00:00:00Z`).getTime() -
      new Date(`${availabilityFrom}T00:00:00Z`).getTime()) /
    86_400_000;
  if (availabilityDays > 62) {
    return Response.json({ error: "Availability range is too large" }, { status: 400 });
  }
  try {
    const snapshot = await readSnapshot(from, to);
    let integration = integrationStatus();
    const slots: ProviderAvailability = { SAC: {}, EB: {} };
    if (integration.mode === "live" && integration.healthy) {
      try {
        const [sacramento, eastBay] = await Promise.all([
          getProviderAvailability({
            territoryId: "SAC",
            from: availabilityFrom,
            to: availabilityTo,
            timeZone: snapshot.settings.timeZone,
          }),
          getProviderAvailability({
            territoryId: "EB",
            from: availabilityFrom,
            to: availabilityTo,
            timeZone: snapshot.settings.timeZone,
          }),
        ]);
        slots.SAC = sacramento;
        slots.EB = eastBay;
      } catch (error) {
        integration = {
          mode: "live",
          healthy: false,
          message: `Cal.com availability unavailable: ${error instanceof Error ? error.message : "request failed"}`,
        };
      }
    }
    return Response.json({
      ...snapshot,
      integration,
      providerAvailability: {
        mode: integration.mode === "live" ? "provider" : "local",
        from: availabilityFrom,
        to: availabilityTo,
        slots,
      },
      currentUser: auth.actor,
      serverNow: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Calendar unavailable" },
      { status: 500 },
    );
  }
}
