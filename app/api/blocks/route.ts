import { readSnapshot } from "@/db/runtime";
import { requireActor } from "@/lib/auth";
import { BlockError, createCapacityRule, type BulkBlockInput } from "@/lib/blocks";
import type { TerritoryId } from "@/lib/types";

type SingleBlockInput = {
  territoryId?: TerritoryId;
  date?: string;
  slot?: string;
  type?: "SEATS" | "ALL";
  seats?: number;
  reason?: string;
};

export async function POST(request: Request) {
  const auth = await requireActor(request, ["master_admin", "manager"]);
  if (auth.response) return auth.response;
  try {
    const payload = (await request.json().catch(() => null)) as
      | (BulkBlockInput & SingleBlockInput)
      | null;
    if (!payload) throw new BlockError("Invalid capacity block request", 400);
    let input: BulkBlockInput = payload;
    if (payload.territoryId) {
      const date = payload.date ?? "";
      const snapshot = await readSnapshot(date, date);
      const capacity = snapshot.lanes.filter(
        (lane) => lane.active && lane.territoryId === payload.territoryId,
      ).length;
      input = {
        territories: [
          {
            territoryId: payload.territoryId,
            seats: payload.type === "ALL" ? capacity : Number(payload.seats ?? 1),
          },
        ],
        fromDate: date,
        toDate: date,
        weekdays: [new Date(`${date}T12:00:00Z`).getUTCDay()],
        slots: payload.type === "ALL" ? snapshot.settings.slots : [payload.slot ?? ""],
        reason: payload.reason,
      };
    }
    const result = await createCapacityRule(
      input,
      auth.actor,
      request.headers.get("Idempotency-Key")?.trim() || crypto.randomUUID(),
    );
    const response = result as {
      sync?: { pending?: number; deferred?: number; failed?: number };
    };
    const pending =
      Number(response.sync?.pending ?? 0) +
      Number(response.sync?.deferred ?? 0) +
      Number(response.sync?.failed ?? 0);
    return Response.json(result, { status: pending ? 202 : 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Capacity block failed",
        details: error instanceof BlockError ? error.details : undefined,
      },
      { status: error instanceof BlockError ? error.status : 500 },
    );
  }
}
