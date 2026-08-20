import { ensureDatabase, getRuntimeEnvironment } from "@/db/runtime";
import { integrationStatus } from "@/lib/cal";
import { bootstrapMasterAdmin } from "@/lib/auth";

export async function GET() {
  try {
    await bootstrapMasterAdmin();
    const db = await ensureDatabase();
    const env = getRuntimeEnvironment();
    const integration = integrationStatus();
    const [failedWebhooks, unsyncedAppointments, unsyncedBlocks, masterAdmins, lastReconcile] =
      await db.batch([
        db.prepare("SELECT COUNT(*)::int AS count FROM webhook_events WHERE state='failed'"),
        db.prepare("SELECT COUNT(*)::int AS count FROM appointments WHERE sync_state!='synced'"),
        db.prepare(
          `SELECT COUNT(*)::int AS count FROM capacity_blocks
           WHERE status IN ('active','cancel_pending') AND sync_state NOT IN ('synced','cancelled')`,
        ),
        db.prepare("SELECT COUNT(*)::int AS count FROM users WHERE role='master_admin' AND active=1"),
        db.prepare("SELECT MAX(created_at) AS at FROM audit_log WHERE action='cal.reconciled'"),
      ]);
    const value = (result: { results: unknown[] }) =>
      Number((result.results[0] as { count?: number } | undefined)?.count ?? 0);
    const missingSecrets = [
      !env.SESSION_SECRET && "SESSION_SECRET",
      integration.mode === "live" && !env.CRON_SECRET && "CRON_SECRET",
      integration.mode === "live" && !env.VOICE_AGENT_SECRET && "VOICE_AGENT_SECRET",
    ].filter(Boolean);
    const checks = {
      failedWebhooks: value(failedWebhooks),
      unsyncedAppointments: value(unsyncedAppointments),
      unsyncedCapacityHolds: value(unsyncedBlocks),
      activeMasterAdmins: value(masterAdmins),
      missingSecrets,
      lastReconcileAt:
        (lastReconcile.results[0] as { at?: Date | string | null } | undefined)?.at ?? null,
    };
    const degraded =
      !integration.healthy ||
      checks.failedWebhooks > 0 ||
      checks.unsyncedAppointments > 0 ||
      checks.unsyncedCapacityHolds > 0 ||
      checks.activeMasterAdmins < 1 ||
      (process.env.NODE_ENV === "production" && checks.missingSecrets.length > 0);
    return Response.json(
      { status: degraded ? "degraded" : "ok", database: "ok", cal: integration, checks, checkedAt: new Date().toISOString() },
      { status: 200 },
    );
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : "Health check failed" },
      { status: 503 },
    );
  }
}
