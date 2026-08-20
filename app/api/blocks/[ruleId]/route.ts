import { requireActor } from "@/lib/auth";
import { BlockError, cancelCapacityRule } from "@/lib/blocks";

type RouteContext = { params: Promise<{ ruleId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireActor(request, ["master_admin", "manager"]);
  if (auth.response) return auth.response;
  const { ruleId } = await context.params;
  try {
    const result = await cancelCapacityRule(ruleId, auth.actor);
    return Response.json(result, { status: result.pending ? 202 : 200 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Capacity block could not be removed" },
      { status: error instanceof BlockError ? error.status : 500 },
    );
  }
}
