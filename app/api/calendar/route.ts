import { readSnapshot } from "@/db/runtime";
import { integrationStatus } from "@/lib/cal";
import { requireActor } from "@/lib/auth";

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
  try {
    const snapshot = await readSnapshot(from, to);
    return Response.json({
      ...snapshot,
      integration: integrationStatus(),
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
