import { ensureDatabase, readSnapshot } from "@/db/runtime";
import { listCalBookings, type CalAttendee, type CalBooking } from "@/lib/cal";
import { computeCellState, localDateAndSlot } from "@/lib/domain.mjs";
import type { TerritoryId } from "@/lib/types";

function confirmation() {
  return `ES-CAL${crypto.randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;
}

function mappedStatus(status: string) {
  return ["cancelled", "rejected"].includes(status.toLowerCase()) ? "Cancelled" : "Scheduled";
}

function externalKey(booking: CalBooking, attendee: CalAttendee) {
  return attendee.seatUid || `${booking.uid}:${attendee.email.toLowerCase()}`;
}

function isCapacityHold(attendee: CalAttendee, booking: CalBooking) {
  return (
    booking.metadata?.kind === "capacity_hold" ||
    attendee.name === "Eagle Shield Capacity Hold" ||
    /\+hold-[^@]+@/i.test(attendee.email)
  );
}

export async function syncCalBooking(
  booking: CalBooking,
  territoryId: TerritoryId,
  source = "cal-reconciler",
) {
  if (!booking.uid || !booking.start || !booking.end) {
    return { action: "ignored", reason: "incomplete", synced: 0 } as const;
  }
  const preliminary = localDateAndSlot(booking.start, "America/Los_Angeles");
  const initialSnapshot = await readSnapshot(preliminary.date, preliminary.date);
  const local = localDateAndSlot(booking.start, initialSnapshot.settings.timeZone);
  const attendees = (booking.attendees?.length
    ? booking.attendees
    : [{ name: "Cal.com Customer", email: "", seatUid: booking.seatUid }]
  ).filter((attendee) => !isCapacityHold(attendee, booking));
  if (!attendees.length) return { action: "ignored", reason: "capacity_hold", synced: 0 } as const;
  const db = await ensureDatabase();
  let created = 0;
  let updated = 0;

  for (const attendee of attendees) {
    const key = externalKey(booking, attendee);
    const existing = await db
      .prepare(
        `SELECT id,confirmation,rep_id,lane_id,correlation_id FROM appointments
         WHERE external_key=? LIMIT 1`,
      )
      .bind(key)
      .first<{
        id: string;
        confirmation: string;
        rep_id: string | null;
        lane_id: string;
        correlation_id: string;
      }>();
    const snapshot = await readSnapshot(local.date, local.date);
    const state = computeCellState({
      territoryId,
      date: local.date,
      slot: local.slot,
      lanes: snapshot.lanes,
      reps: snapshot.reps,
      appointments: snapshot.appointments.filter((item) => item.id !== existing?.id),
      blocks: snapshot.blocks,
      settings: snapshot.settings,
      now: new Date().toISOString(),
    });
    const id = existing?.id ?? crypto.randomUUID();
    let laneId = existing?.lane_id ?? state.openLaneIds[0];
    if (!laneId) {
      laneId = `overflow_${id}`;
      await db
        .prepare(
          `INSERT INTO lanes (id,territory_id,label,ordinal,active)
           VALUES (?,?,?,9999,0) ON CONFLICT (id) DO NOTHING`,
        )
        .bind(laneId, territoryId, `Over-capacity import ${id}`)
        .run();
    }
    const fields = booking.bookingFieldsResponses ?? {};
    const status = mappedStatus(booking.status);
    if (existing) {
      await db
        .prepare(
          `UPDATE appointments SET cal_uid=?,cal_seat_uid=?,customer_name=?,customer_email=?,
           phone=?,address=?,zip=?,territory_id=?,lane_id=?,date=?,slot=?,start_at=?,end_at=?,
           status=?,cal_status=?,source=?,sync_state='synced',updated_at=CURRENT_TIMESTAMP
           WHERE id=?`,
        )
        .bind(
          booking.uid,
          attendee.seatUid ?? booking.seatUid ?? null,
          attendee.name || "Cal.com Customer",
          attendee.email || "",
          attendee.phoneNumber || "",
          fields.serviceAddress || fields.address || "",
          fields.zip || "",
          territoryId,
          laneId,
          local.date,
          local.slot,
          booking.start,
          booking.end,
          status,
          booking.status,
          booking.metadata?.source || source,
          existing.id,
        )
        .run();
      updated += 1;
    } else {
      await db
        .prepare(
          `INSERT INTO appointments (
           id,cal_uid,cal_seat_uid,external_key,confirmation,customer_name,customer_email,
           phone,address,zip,territory_id,rep_id,lane_id,date,slot,start_at,end_at,status,
           cal_status,source,sync_state,correlation_id
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          booking.uid,
          attendee.seatUid ?? booking.seatUid ?? null,
          key,
          confirmation(),
          attendee.name || "Cal.com Customer",
          attendee.email || "",
          attendee.phoneNumber || "",
          fields.serviceAddress || fields.address || "",
          fields.zip || "",
          territoryId,
          null,
          laneId,
          local.date,
          local.slot,
          booking.start,
          booking.end,
          status,
          booking.status,
          booking.metadata?.source || source,
          "synced",
          booking.metadata?.correlation_id || crypto.randomUUID(),
        )
        .run();
      created += 1;
    }
  }
  return { action: created ? "created" : "updated", created, updated, synced: created + updated } as const;
}

export async function reconcileCalBookings() {
  const results = await Promise.allSettled(
    (["SAC", "EB"] as const).map(async (territoryId) => {
      const bookings = await listCalBookings(territoryId);
      let synced = 0;
      let failed = 0;
      for (const booking of bookings) {
        try {
          synced += (await syncCalBooking(booking, territoryId)).synced;
        } catch {
          failed += 1;
        }
      }
      return { scanned: bookings.length, synced, failed };
    }),
  );
  return results.reduce(
    (summary, result) => {
      if (result.status === "fulfilled") {
        summary.scanned += result.value.scanned;
        summary.synced += result.value.synced;
        summary.failed += result.value.failed;
      } else {
        summary.failed += 1;
      }
      return summary;
    },
    { scanned: 0, synced: 0, failed: 0 },
  );
}
