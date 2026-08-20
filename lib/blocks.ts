import {
  beginIdempotentOperation,
  ensureDatabase,
  failIdempotentOperation,
  finishIdempotentOperation,
  getIdempotentResponse,
  getRuntimeEnvironment,
  readSnapshot,
  writeAudit,
} from "@/db/runtime";
import {
  CalApiError,
  cancelCalBooking,
  createCalBooking,
  getCalBooking,
  integrationStatus,
  seatUidFor,
} from "@/lib/cal";
import { addDays, toUtcIso, weekday, zonedDateParts } from "@/lib/domain.mjs";
import type { Actor } from "@/lib/auth";
import type { TerritoryId } from "@/lib/types";

export type BulkBlockInput = {
  territories?: Array<{ territoryId?: TerritoryId; seats?: number }>;
  fromDate?: string;
  toDate?: string;
  weekdays?: number[];
  slots?: string[];
  reason?: string;
};

type BlockRow = {
  id: string;
  rule_id: string;
  territory_id: TerritoryId;
  lane_id: string;
  date: string;
  slot: string;
  reason: string;
  cal_uid: string | null;
  cal_seat_uid: string | null;
  status: string;
  sync_state: string;
};

export class BlockError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function datePattern(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function datesBetween(from: string, to: string, weekdays: Set<number>) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (weekdays.has(weekday(date))) dates.push(date);
  }
  return dates;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

export function capacityHoldEmail(blockId: string) {
  const base = getRuntimeEnvironment().CAL_HOLD_EMAIL || "calendar@eagleshield.com";
  const [local, domain] = base.split("@");
  return domain ? `${local}+hold-${blockId.slice(0, 12)}@${domain}` : base;
}

async function updateBlockSync(
  blockId: string,
  values: {
    calUid?: string | null;
    calSeatUid?: string | null;
    syncState: string;
    error?: string | null;
    status?: string;
  },
) {
  const db = await ensureDatabase();
  await db
    .prepare(
      `UPDATE capacity_blocks SET cal_uid=COALESCE(?,cal_uid),
       cal_seat_uid=COALESCE(?,cal_seat_uid),sync_state=?,error_message=?,
       status=COALESCE(?,status),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    )
    .bind(
      values.calUid ?? null,
      values.calSeatUid ?? null,
      values.syncState,
      values.error ?? null,
      values.status ?? null,
      blockId,
    )
    .run();
}

export async function syncCapacityBlock(block: BlockRow) {
  const integration = integrationStatus();
  if (integration.mode === "mock") {
    await updateBlockSync(block.id, {
      calUid: block.cal_uid ?? `mock_hold_${block.id}`,
      calSeatUid: block.cal_seat_uid ?? `mock_seat_${block.id}`,
      syncState: "synced",
    });
    return { id: block.id, state: "synced" } as const;
  }
  const snapshot = await readSnapshot(block.date, block.date);
  const email = capacityHoldEmail(block.id);
  try {
    if (block.cal_uid && !block.cal_seat_uid && block.territory_id === "SAC") {
      const existing = await getCalBooking(block.territory_id, block.cal_uid);
      const seatUid = seatUidFor(existing, email);
      if (!seatUid) throw new CalApiError("Cal.com has not exposed the hold seat UID yet", 503);
      await updateBlockSync(block.id, { calSeatUid: seatUid, syncState: "synced" });
      return { id: block.id, state: "synced" } as const;
    }
    if (block.cal_uid) {
      await updateBlockSync(block.id, { syncState: "synced" });
      return { id: block.id, state: "synced" } as const;
    }
    const booking = await createCalBooking(block.territory_id, {
      start: toUtcIso(block.date, block.slot, snapshot.settings.timeZone),
      attendee: {
        name: "Eagle Shield Capacity Hold",
        email,
        timeZone: snapshot.settings.timeZone,
        language: "en",
      },
      metadata: {
        kind: "capacity_hold",
        block_id: block.id,
        rule_id: block.rule_id,
        territory: block.territory_id,
        lane_id: block.lane_id,
      },
    });
    const seatUid = seatUidFor(booking, email) ?? null;
    await updateBlockSync(block.id, {
      calUid: booking.uid,
      calSeatUid: seatUid,
      syncState: block.territory_id === "SAC" && !seatUid ? "pending" : "synced",
      error:
        block.territory_id === "SAC" && !seatUid
          ? "Waiting for Cal.com to expose the seated booking identifier"
          : null,
    });
    return {
      id: block.id,
      state: block.territory_id === "SAC" && !seatUid ? "pending" : "synced",
    } as const;
  } catch (error) {
    const deferred = error instanceof CalApiError && [400, 409, 422].includes(error.status);
    await updateBlockSync(block.id, {
      syncState: deferred ? "deferred" : "failed",
      error: error instanceof Error ? error.message : "Cal.com hold failed",
    });
    return { id: block.id, state: deferred ? "deferred" : "failed" } as const;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

export async function syncCapacityRule(ruleId: string) {
  const db = await ensureDatabase();
  const rows = await db
    .prepare(
      `SELECT * FROM capacity_blocks
       WHERE rule_id=? AND status='active' AND sync_state!='synced'
       ORDER BY date,slot,lane_id`,
    )
    .bind(ruleId)
    .all<BlockRow>();
  const results = await mapLimit(rows.results, 4, syncCapacityBlock);
  return {
    total: rows.results.length,
    synced: results.filter((result) => result.state === "synced").length,
    pending: results.filter((result) => result.state === "pending").length,
    deferred: results.filter((result) => result.state === "deferred").length,
    failed: results.filter((result) => result.state === "failed").length,
  };
}

export async function createCapacityRule(
  input: BulkBlockInput,
  actor: Actor,
  idempotencyKey: string,
) {
  const previous = await getIdempotentResponse(idempotencyKey);
  if (previous) return previous;
  if (!(await beginIdempotentOperation(idempotencyKey, "capacity.bulk_create"))) {
    throw new BlockError("This bulk block request is already processing", 409);
  }
  try {
    const fromDate = input.fromDate ?? "";
    const toDate = input.toDate ?? fromDate;
    if (!datePattern(fromDate) || !datePattern(toDate) || fromDate > toDate) {
      throw new BlockError("A valid start and end date are required", 400);
    }
    const snapshot = await readSnapshot(fromDate, toDate);
    const today = zonedDateParts(new Date().toISOString(), snapshot.settings.timeZone).date;
    if (fromDate < today) throw new BlockError("Past dates cannot be blocked", 400);
    const span =
      (new Date(`${toDate}T00:00:00Z`).getTime() -
        new Date(`${fromDate}T00:00:00Z`).getTime()) /
      86_400_000;
    if (span > 370) throw new BlockError("Bulk blocks are limited to 371 days", 400);
    const weekdays = new Set(
      unique((input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5, 6]).map(Number)),
    );
    if ([...weekdays].some((day) => !Number.isInteger(day) || day < 1 || day > 6)) {
      throw new BlockError("Select valid operating weekdays", 400);
    }
    const slots = unique(input.slots ?? []).filter((slot) => snapshot.settings.slots.includes(slot));
    if (!slots.length || slots.length !== unique(input.slots ?? []).length) {
      throw new BlockError("Select at least one valid appointment time", 400);
    }
    const requested = input.territories ?? [];
    if (!requested.length) throw new BlockError("Select at least one location", 400);
    const byTerritory = new Map<TerritoryId, number>();
    for (const item of requested) {
      if (!item.territoryId || !(["SAC", "EB"] as string[]).includes(item.territoryId)) {
        throw new BlockError("Unknown location", 400);
      }
      const seats = Number(item.seats ?? 0);
      const capacity = snapshot.lanes.filter(
        (lane) => lane.active && lane.territoryId === item.territoryId,
      ).length;
      if (!Number.isInteger(seats) || seats < 1 || seats > capacity) {
        throw new BlockError(`${item.territoryId} can block between 1 and ${capacity} seats`, 400);
      }
      byTerritory.set(item.territoryId, seats);
    }
    const dates = datesBetween(fromDate, toDate, weekdays);
    if (!dates.length) throw new BlockError("The selected range has no matching operating days", 400);
    const projected = dates.length * slots.length * [...byTerritory.values()].reduce((a, b) => a + b, 0);
    if (projected > 1_000) {
      throw new BlockError("This bulk block would create more than 1,000 holds; use a smaller range", 400);
    }

    const conflicts: Array<{ territoryId: TerritoryId; date: string; slot: string }> = [];
    const rows: BlockRow[] = [];
    const ruleId = crypto.randomUUID();
    for (const [territoryId, seatCount] of byTerritory) {
      const laneIds = snapshot.lanes
        .filter((lane) => lane.active && lane.territoryId === territoryId)
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((lane) => lane.id);
      for (const date of dates) {
        for (const slot of slots) {
          const alreadyBlocked = new Set(
            snapshot.blocks
              .filter(
                (block) =>
                  block.territoryId === territoryId && block.date === date && block.slot === slot,
              )
              .map((block) => block.laneId),
          );
          const usedByAppointment = new Set(
            snapshot.appointments
              .filter(
                (appointment) =>
                  appointment.territoryId === territoryId &&
                  appointment.date === date &&
                  appointment.slot === slot &&
                  appointment.status !== "Cancelled",
              )
              .map((appointment) => appointment.laneId),
          );
          const available = laneIds
            .filter((laneId) => !alreadyBlocked.has(laneId))
            .sort((left, right) => Number(usedByAppointment.has(left)) - Number(usedByAppointment.has(right)));
          if (available.length < seatCount) {
            conflicts.push({ territoryId, date, slot });
            continue;
          }
          for (const laneId of available.slice(0, seatCount)) {
            rows.push({
              id: crypto.randomUUID(),
              rule_id: ruleId,
              territory_id: territoryId,
              lane_id: laneId,
              date,
              slot,
              reason: input.reason?.trim() || "Capacity hold",
              cal_uid: null,
              cal_seat_uid: null,
              status: "active",
              sync_state: "pending",
            });
          }
        }
      }
    }
    if (conflicts.length) {
      throw new BlockError(
        `${conflicts.length} selected location/time combinations already have capacity blocks`,
        409,
        conflicts.slice(0, 20),
      );
    }
    const db = await ensureDatabase();
    await db.batch([
      db
        .prepare(
          `INSERT INTO capacity_block_rules
           (id,reason,from_date,to_date,weekdays_json,slots_json,territories_json,status,created_by)
           VALUES (?,?,?,?,?,?,?,'active',?)`,
        )
        .bind(
          ruleId,
          input.reason?.trim() || "Capacity hold",
          fromDate,
          toDate,
          JSON.stringify([...weekdays]),
          JSON.stringify(slots),
          JSON.stringify([...byTerritory].map(([territoryId, seats]) => ({ territoryId, seats }))),
          actor.id,
        ),
      ...rows.map((row) =>
        db
          .prepare(
            `INSERT INTO capacity_blocks
             (id,rule_id,territory_id,lane_id,date,slot,reason,status,sync_state)
             VALUES (?,?,?,?,?,?,?,'active','pending')`,
          )
          .bind(row.id, ruleId, row.territory_id, row.lane_id, row.date, row.slot, row.reason),
      ),
    ]);
    const sync = await syncCapacityRule(ruleId);
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "capacity.bulk_blocked",
      entityType: "capacity_rule",
      entityId: ruleId,
      detail: { fromDate, toDate, weekdays: [...weekdays], slots, territories: [...byTerritory], rows: rows.length, sync },
      correlationId: ruleId,
    });
    const response = { ruleId, blockedSeats: rows.length, dates: dates.length, sync };
    await finishIdempotentOperation(idempotencyKey, response);
    return response;
  } catch (error) {
    await failIdempotentOperation(idempotencyKey);
    throw error;
  }
}

async function cancelCapacityBlock(block: BlockRow) {
  const integration = integrationStatus();
  if (integration.mode === "mock" || !block.cal_uid) {
    await updateBlockSync(block.id, { syncState: "cancelled", status: "cancelled" });
    return { id: block.id, state: "cancelled" } as const;
  }
  try {
    let seatUid = block.cal_seat_uid;
    if (block.territory_id === "SAC" && !seatUid) {
      const booking = await getCalBooking(block.territory_id, block.cal_uid);
      seatUid = seatUidFor(booking, capacityHoldEmail(block.id)) ?? null;
    }
    await cancelCalBooking(block.territory_id, block.cal_uid, "Capacity block removed", seatUid);
    await updateBlockSync(block.id, {
      calSeatUid: seatUid,
      syncState: "cancelled",
      status: "cancelled",
    });
    return { id: block.id, state: "cancelled" } as const;
  } catch (error) {
    await updateBlockSync(block.id, {
      syncState: "cancel_failed",
      status: "cancel_pending",
      error: error instanceof Error ? error.message : "Cal.com cancellation failed",
    });
    return { id: block.id, state: "cancel_failed" } as const;
  }
}

export async function cancelCapacityRule(ruleId: string, actor: Actor) {
  const db = await ensureDatabase();
  const rows = await db
    .prepare("SELECT * FROM capacity_blocks WHERE rule_id=? AND status IN ('active','cancel_pending')")
    .bind(ruleId)
    .all<BlockRow>();
  if (!rows.results.length) throw new BlockError("Capacity block not found", 404);
  await db.batch([
    db
      .prepare("UPDATE capacity_block_rules SET status='cancel_pending',updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(ruleId),
    db
      .prepare("UPDATE capacity_blocks SET status='cancel_pending',updated_at=CURRENT_TIMESTAMP WHERE rule_id=? AND status='active'")
      .bind(ruleId),
  ]);
  const results = await mapLimit(rows.results, 4, cancelCapacityBlock);
  const failed = results.filter((result) => result.state === "cancel_failed").length;
  if (!failed) {
    await db
      .prepare("UPDATE capacity_block_rules SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(ruleId)
      .run();
  }
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "capacity.bulk_unblocked",
    entityType: "capacity_rule",
    entityId: ruleId,
    detail: { rows: rows.results.length, failed },
    correlationId: ruleId,
  });
  return { ruleId, removed: rows.results.length - failed, pending: failed };
}

export async function reconcileCapacityBlocks() {
  const db = await ensureDatabase();
  const active = await db
    .prepare(
      `SELECT * FROM capacity_blocks
       WHERE status='active' AND sync_state IN ('pending','deferred','failed')
       ORDER BY updated_at LIMIT 250`,
    )
    .all<BlockRow>();
  const cancelling = await db
    .prepare(
      `SELECT * FROM capacity_blocks
       WHERE status='cancel_pending' ORDER BY updated_at LIMIT 250`,
    )
    .all<BlockRow>();
  const sync = await mapLimit(active.results, 4, syncCapacityBlock);
  const cancel = await mapLimit(cancelling.results, 4, cancelCapacityBlock);
  const ruleCandidates = await db
    .prepare("SELECT id FROM capacity_block_rules WHERE status='cancel_pending'")
    .all<{ id: string }>();
  let completedRules = 0;
  for (const rule of ruleCandidates.results) {
    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM capacity_blocks WHERE rule_id=? AND status='cancel_pending'")
      .bind(rule.id)
      .first<{ count: number | string }>();
    if (Number(remaining?.count ?? 0) === 0) {
      const updated = await db
        .prepare(
          "UPDATE capacity_block_rules SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='cancel_pending'",
        )
        .bind(rule.id)
        .run();
      completedRules += updated.meta.changes;
    }
  }
  return {
    scanned: active.results.length + cancelling.results.length,
    synced: sync.filter((result) => result.state === "synced").length,
    deferred: sync.filter((result) => result.state === "deferred").length,
    failed: sync.filter((result) => result.state === "failed").length,
    cancelled: cancel.filter((result) => result.state === "cancelled").length,
    cancelFailed: cancel.filter((result) => result.state === "cancel_failed").length,
    completedRules,
  };
}
