import { ensureDatabase, territoryForEventType } from "@/db/runtime";
import { syncCalBooking } from "@/lib/reconcile";
import type { CalBooking } from "@/lib/cal";
import type { TerritoryId } from "@/lib/types";

export type CalWebhookPayload = {
  triggerEvent?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

function object(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function string(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

export function bookingFromWebhookPayload(payload: Record<string, unknown>): CalBooking {
  const eventType = object(payload.eventType);
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees.map((item) => object(item))
    : payload.attendee
      ? [object(payload.attendee)]
      : [];
  const seatUid =
    string(payload, "seatUid", "seatReferenceUid") ||
    string(attendees[0] ?? {}, "seatUid", "seatReferenceUid") ||
    undefined;
  return {
    id: Number(string(payload, "id") || 0),
    uid: string(payload, "uid", "bookingUid"),
    seatUid,
    status: string(payload, "status") || "accepted",
    start: string(payload, "startTime", "start"),
    end: string(payload, "endTime", "end"),
    eventTypeId: Number(string(payload, "eventTypeId") || string(eventType, "id") || 0),
    attendees: attendees.map((attendee) => ({
      name: string(attendee, "name"),
      email: string(attendee, "email"),
      phoneNumber: string(attendee, "phoneNumber") || undefined,
      seatUid: string(attendee, "seatUid", "seatReferenceUid") || seatUid,
    })),
    bookingFieldsResponses: Object.fromEntries(
      Object.entries(object(payload.bookingFieldsResponses)).map(([key, value]) => [key, String(value ?? "")]),
    ),
    metadata: Object.fromEntries(
      Object.entries(object(payload.metadata)).map(([key, value]) => [key, String(value ?? "")]),
    ),
    rescheduledFromUid: string(payload, "rescheduledFromUid", "rescheduleUid") || undefined,
    rescheduledToUid: string(payload, "rescheduledToUid") || undefined,
  };
}

export function territoryForWebhook(booking: CalBooking) {
  const configured = territoryForEventType(booking.eventTypeId);
  if (configured) return configured;
  const metadataTerritory = booking.metadata?.territory;
  return metadataTerritory === "SAC" || metadataTerritory === "EB" ? metadataTerritory : null;
}

export async function beginCalWebhookAttempt(input: {
  fingerprint: string;
  trigger: string;
  bookingUid: string | null;
  rawBody: string;
}) {
  const db = await ensureDatabase();
  const claimExisting = async (state: string | undefined) => {
    if (state === "processed") return "duplicate" as const;
    if (state !== "failed") return "processing" as const;
    const claimed = await db
      .prepare(
        `UPDATE webhook_events
         SET state='received',error_message=NULL,attempt_count=attempt_count+1,
             last_attempt_at=CURRENT_TIMESTAMP,processed_at=NULL
         WHERE fingerprint=? AND state='failed' RETURNING id`,
      )
      .bind(input.fingerprint)
      .first<{ id: string }>();
    return claimed ? "claimed" as const : "processing" as const;
  };
  const existing = await db
    .prepare("SELECT state FROM webhook_events WHERE fingerprint=?")
    .bind(input.fingerprint)
    .first<{ state: string }>();
  if (existing) return claimExisting(existing.state);

  const inserted = await db
    .prepare(
      `INSERT INTO webhook_events
       (id,fingerprint,trigger,booking_uid,payload_json,state,attempt_count,last_attempt_at)
       VALUES (?,?,?,?,?,'received',1,CURRENT_TIMESTAMP)
       ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
    )
    .bind(crypto.randomUUID(), input.fingerprint, input.trigger, input.bookingUid, input.rawBody)
    .first<{ id: string }>();
  if (inserted) return "claimed" as const;
  const raced = await db
    .prepare("SELECT state FROM webhook_events WHERE fingerprint=?")
    .bind(input.fingerprint)
    .first<{ state: string }>();
  return claimExisting(raced?.state);
}

export async function completeCalWebhookAttempt(fingerprint: string) {
  const db = await ensureDatabase();
  await db
    .prepare(
      `UPDATE webhook_events
       SET state='processed',error_message=NULL,processed_at=CURRENT_TIMESTAMP
       WHERE fingerprint=?`,
    )
    .bind(fingerprint)
    .run();
}

export async function failCalWebhookAttempt(fingerprint: string, error: unknown) {
  const db = await ensureDatabase();
  const message = (error instanceof Error ? error.message : "Webhook processing failed").slice(0, 2_000);
  await db
    .prepare("UPDATE webhook_events SET state='failed',error_message=? WHERE fingerprint=?")
    .bind(message, fingerprint)
    .run();
  return message;
}

export async function applyCalWebhook(
  webhook: CalWebhookPayload,
  booking: CalBooking,
  territoryId: TerritoryId,
) {
  const trigger = webhook.triggerEvent ?? "UNKNOWN";
  const db = await ensureDatabase();
  if (["BOOKING_CANCELLED", "BOOKING_REJECTED"].includes(trigger) && booking.uid) {
    const attendee = booking.attendees?.[0];
    const key =
      booking.seatUid ||
      attendee?.seatUid ||
      (attendee?.email ? `${booking.uid}:${attendee.email.toLowerCase()}` : "");
    if (key) {
      await db
        .prepare(
          `UPDATE appointments SET status='Cancelled',cal_status=?,sync_state='synced',
           updated_at=CURRENT_TIMESTAMP WHERE external_key=?`,
        )
        .bind(trigger === "BOOKING_REJECTED" ? "rejected" : "cancelled", key)
        .run();
    } else if (territoryId === "EB") {
      await db
        .prepare(
          `UPDATE appointments SET status='Cancelled',cal_status=?,sync_state='synced',
           updated_at=CURRENT_TIMESTAMP WHERE cal_uid=?`,
        )
        .bind(trigger === "BOOKING_REJECTED" ? "rejected" : "cancelled", booking.uid)
        .run();
    } else {
      throw new Error("Sacramento seat cancellation did not include a seat identifier");
    }
  } else if (
    ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_REQUESTED", "BOOKING_CONFIRMED"].includes(trigger)
  ) {
    await syncCalBooking(booking, territoryId, "cal-webhook");
  }
}

export async function retryFailedCalWebhooks(limit = 25) {
  const db = await ensureDatabase();
  const failed = await db
    .prepare(
      `SELECT fingerprint,payload_json FROM webhook_events
       WHERE state='failed' AND attempt_count<10 ORDER BY received_at LIMIT ?`,
    )
    .bind(limit)
    .all<{ fingerprint: string; payload_json: string }>();
  const summary = { scanned: failed.results.length, retried: 0, processed: 0, failed: 0 };
  for (const row of failed.results) {
    const claimed = await db
      .prepare(
        `UPDATE webhook_events
         SET state='received',error_message=NULL,attempt_count=attempt_count+1,
             last_attempt_at=CURRENT_TIMESTAMP,processed_at=NULL
         WHERE fingerprint=? AND state='failed' RETURNING id`,
      )
      .bind(row.fingerprint)
      .first<{ id: string }>();
    if (!claimed) continue;
    summary.retried += 1;
    try {
      const webhook = JSON.parse(row.payload_json) as CalWebhookPayload;
      const booking = bookingFromWebhookPayload(webhook.payload ?? {});
      const territoryId = territoryForWebhook(booking);
      if (!territoryId) throw new Error("Webhook retry could not identify the managed Cal.com location");
      await applyCalWebhook(webhook, booking, territoryId);
      await completeCalWebhookAttempt(row.fingerprint);
      summary.processed += 1;
    } catch (error) {
      await failCalWebhookAttempt(row.fingerprint, error);
      summary.failed += 1;
    }
  }
  return summary;
}
