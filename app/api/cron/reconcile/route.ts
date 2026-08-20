import { ensureDatabase, getRuntimeEnvironment, writeAudit } from "@/db/runtime";
import { integrationStatus } from "@/lib/cal";
import { reconcileCapacityBlocks } from "@/lib/blocks";
import { reconcileCalBookings } from "@/lib/reconcile";

function authorized(request: Request) {
  const env = getRuntimeEnvironment();
  const url = new URL(request.url);
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)) return true;
  return Boolean(env.CRON_SECRET) && request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const integration = integrationStatus();
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO settings (key,value) VALUES ('reconcile_lock','1970-01-01T00:00:00.000Z')
       ON CONFLICT (key) DO NOTHING`,
    )
    .run();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const lock = await db
    .prepare("UPDATE settings SET value=? WHERE key='reconcile_lock' AND value<?")
    .bind(expires, now)
    .run();
  if (!lock.meta.changes) {
    return Response.json({ error: "Reconciliation is already running" }, { status: 409 });
  }
  try {
    const holds = await reconcileCapacityBlocks();
    const bookings = integration.mode === "live"
      ? await reconcileCalBookings()
      : { scanned: 0, synced: 0, failed: 0 };
    await writeAudit({
      actorId: "system-reconciler",
      actorEmail: "",
      action: "cal.reconciled",
      entityType: "integration",
      entityId: "cal.com",
      detail: { bookings, holds },
      correlationId: crypto.randomUUID(),
    });
    const failures = bookings.failed + holds.failed + holds.cancelFailed;
    return Response.json(
      { mode: integration.mode, bookings, holds },
      { status: failures ? 207 : 200 },
    );
  } finally {
    await db.prepare("UPDATE settings SET value='1970-01-01T00:00:00.000Z' WHERE key='reconcile_lock'").run();
  }
}
