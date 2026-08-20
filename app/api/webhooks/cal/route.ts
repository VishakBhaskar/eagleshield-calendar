import { ensureDatabase, getRuntimeEnvironment, territoryForEventType } from "@/db/runtime";
import { type CalBooking, verifyCalWebhook } from "@/lib/cal";
import { syncCalBooking } from "@/lib/reconcile";
import type { TerritoryId } from "@/lib/types";

type CalWebhookPayload = {
  triggerEvent?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

function bookingFromPayload(payload: Record<string, unknown>): CalBooking {
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
    rescheduledFromUid: string(payload, "rescheduledFromUid") || undefined,
    rescheduledToUid: string(payload, "rescheduledToUid") || undefined,
  };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const url = new URL(request.url);
  const localTest =
    getRuntimeEnvironment().ALLOW_TEST_WEBHOOKS === "true" &&
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    request.headers.get("x-eagle-test-webhook") === "true";
  let verifiedTerritory = localTest
    ? (request.headers.get("x-eagle-cal-territory") as TerritoryId | null)
    : await verifyCalWebhook(rawBody, request.headers.get("x-cal-signature-256"));
  if (!localTest && !verifiedTerritory) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  let webhook: CalWebhookPayload;
  try {
    webhook = JSON.parse(rawBody) as CalWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const trigger = webhook.triggerEvent ?? "UNKNOWN";
  const payload = webhook.payload ?? {};
  const booking = bookingFromPayload(payload);
  verifiedTerritory =
    verifiedTerritory ?? territoryForEventType(booking.eventTypeId) ??
    ((booking.metadata?.territory as TerritoryId | undefined) ?? null);
  if (!verifiedTerritory || !(verifiedTerritory === "SAC" || verifiedTerritory === "EB")) {
    return Response.json({ received: true, ignored: "unmanaged event type" });
  }
  const configuredTerritory = territoryForEventType(booking.eventTypeId);
  if (configuredTerritory && configuredTerritory !== verifiedTerritory) {
    return Response.json({ error: "Webhook account and event type do not match" }, { status: 400 });
  }
  const fingerprint = await sha256(
    `${verifiedTerritory}|${trigger}|${booking.uid}|${booking.seatUid ?? ""}|${webhook.createdAt ?? ""}|${rawBody}`,
  );
  const db = await ensureDatabase();
  const existing = await db
    .prepare("SELECT id FROM webhook_events WHERE fingerprint=?")
    .bind(fingerprint)
    .first<{ id: string }>();
  if (existing) return Response.json({ received: true, duplicate: true });
  const inserted = await db
    .prepare(
      `INSERT INTO webhook_events
       (id,fingerprint,trigger,booking_uid,payload_json,state)
       VALUES (?,?,?,?,?,'received') ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
    )
    .bind(crypto.randomUUID(), fingerprint, trigger, booking.uid || null, rawBody)
    .first<{ id: string }>();
  if (!inserted) return Response.json({ received: true, duplicate: true });
  try {
    if (["BOOKING_CANCELLED", "BOOKING_REJECTED"].includes(trigger) && booking.uid) {
      const attendee = booking.attendees?.[0];
      const key = booking.seatUid || attendee?.seatUid || (attendee?.email ? `${booking.uid}:${attendee.email.toLowerCase()}` : "");
      if (key) {
        await db
          .prepare(
            `UPDATE appointments SET status='Cancelled',cal_status=?,sync_state='synced',
             updated_at=CURRENT_TIMESTAMP WHERE external_key=?`,
          )
          .bind(trigger === "BOOKING_REJECTED" ? "rejected" : "cancelled", key)
          .run();
      } else if (verifiedTerritory === "EB") {
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
      await syncCalBooking(booking, verifiedTerritory, "cal-webhook");
    }
    await db
      .prepare("UPDATE webhook_events SET state='processed',processed_at=CURRENT_TIMESTAMP WHERE fingerprint=?")
      .bind(fingerprint)
      .run();
    return Response.json({ received: true });
  } catch (error) {
    await db.prepare("UPDATE webhook_events SET state='failed' WHERE fingerprint=?").bind(fingerprint).run();
    return Response.json(
      { error: error instanceof Error ? error.message : "Webhook processing failed" },
      { status: 500 },
    );
  }
}
