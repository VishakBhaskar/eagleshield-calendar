import {
  beginIdempotentOperation,
  ensureDatabase,
  failIdempotentOperation,
  finishIdempotentOperation,
  getIdempotentResponse,
  readSnapshot,
  writeAudit,
} from "@/db/runtime";
import { requireActor } from "@/lib/auth";
import {
  cancelCalBooking,
  createCalBooking,
  getAvailableSlots,
  getCalBooking,
  integrationStatus,
  seatUidFor,
} from "@/lib/cal";
import {
  addMinutes,
  computeCellState,
  toUtcIso,
  weekday,
  zonedDateParts,
} from "@/lib/domain.mjs";
import type { Appointment, Rep, TerritoryId } from "@/lib/types";

type AppointmentInput = {
  customerName?: string;
  customerEmail?: string;
  phone?: string;
  address?: string;
  zip?: string;
  territoryId?: TerritoryId;
  date?: string;
  slot?: string;
  repId?: string;
  source?: string;
};

class ResponseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const slotPattern = /^\d{2}:\d{2}$/;
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const confirmationNumber = () =>
  `ES-${crypto.randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;

function eligible(rep: Rep, territoryId: TerritoryId) {
  return territoryId === "SAC" ? rep.sacramentoEligible : rep.eastBayEligible;
}

export async function POST(request: Request) {
  const auth = await requireActor(request, ["master_admin", "manager", "staff", "voice_agent"]);
  if (auth.response) return auth.response;
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || crypto.randomUUID();
  const previous = await getIdempotentResponse(idempotencyKey);
  if (previous) return Response.json(previous);
  if (!(await beginIdempotentOperation(idempotencyKey, "appointment.create"))) {
    return Response.json({ error: "This booking request is already processing" }, { status: 409 });
  }

  let rollback: { territoryId: TerritoryId; uid: string; seatUid?: string | null } | null = null;
  try {
    const payload = (await request.json()) as AppointmentInput;
    const customerName = payload.customerName?.trim() ?? "";
    const customerEmail = payload.customerEmail?.trim().toLowerCase() ?? "";
    const territoryId = payload.territoryId;
    const date = payload.date ?? "";
    const slot = payload.slot ?? "";
    if (!customerName || !territoryId || !datePattern.test(date) || !slotPattern.test(slot)) {
      throw new ResponseError("Name, location, date, and time are required", 400);
    }
    if (!(territoryId === "SAC" || territoryId === "EB")) {
      throw new ResponseError("Unknown location", 400);
    }
    const snapshot = await readSnapshot(date, date);
    const today = zonedDateParts(new Date().toISOString(), snapshot.settings.timeZone).date;
    if (date < today) throw new ResponseError("Past dates cannot be booked", 400);
    if (weekday(date) === 0) throw new ResponseError("Sundays are closed", 400);
    if (!snapshot.settings.slots.includes(slot)) throw new ResponseError("Unknown appointment time", 400);
    const state = computeCellState({
      territoryId,
      date,
      slot,
      lanes: snapshot.lanes,
      reps: snapshot.reps,
      appointments: snapshot.appointments,
      blocks: snapshot.blocks,
      settings: snapshot.settings,
      now: new Date().toISOString(),
    });
    if (state.cutoff) throw new ResponseError("This date is closed by the after-hours cutoff", 409);
    if (!state.openLaneIds.length) throw new ResponseError("This location and time are full", 409);

    const repId = payload.repId?.trim() ?? "";
    if (repId) {
      const rep = snapshot.reps.find((item) => item.id === repId && item.active);
      if (!rep || !eligible(rep, territoryId)) {
        throw new ResponseError("The selected team member is not eligible for this location", 409);
      }
      if (!state.freeRepIds.includes(repId)) {
        throw new ResponseError("The selected team member already has an appointment at this time", 409);
      }
    }

    const integration = integrationStatus();
    const startAt = toUtcIso(date, slot, snapshot.settings.timeZone);
    const endAt = addMinutes(startAt, snapshot.settings.appointmentDuration);
    const correlationId = crypto.randomUUID();
    let calUid: string | null = null;
    let calSeatUid: string | null = null;
    if (integration.mode === "live") {
      if (!integration.healthy) throw new ResponseError(integration.message, 503);
      if (!isEmail(customerEmail)) {
        throw new ResponseError("A valid customer email is required for Cal.com", 400);
      }
      const slots = await getAvailableSlots({
        territoryId,
        start: date,
        end: date,
        timeZone: snapshot.settings.timeZone,
      });
      const available = Object.values(slots)
        .flat()
        .some((candidate) => new Date(candidate.start).toISOString() === startAt);
      if (!available) throw new ResponseError("Cal.com reports that this time is full", 409);
      const booking = await createCalBooking(territoryId, {
        start: startAt,
        attendee: {
          name: customerName,
          email: customerEmail,
          phoneNumber: payload.phone?.trim() || undefined,
          timeZone: snapshot.settings.timeZone,
          language: "en",
        },
        bookingFieldsResponses: {
          serviceAddress: payload.address?.trim() ?? "",
          zip: payload.zip?.trim() ?? "",
        },
        metadata: {
          correlation_id: correlationId,
          territory: territoryId,
          source: auth.actor.id === "voice-agent" ? "voice-agent" : "calendar-ui",
        },
      });
      calUid = booking.uid;
      calSeatUid = seatUidFor(booking, customerEmail) ?? null;
      if (territoryId === "SAC" && !calSeatUid) {
        const hydrated = await getCalBooking(territoryId, booking.uid);
        calSeatUid = seatUidFor(hydrated, customerEmail) ?? null;
      }
      rollback = { territoryId, uid: booking.uid, seatUid: calSeatUid };
    } else {
      calUid = `mock_${crypto.randomUUID()}`;
      calSeatUid = territoryId === "SAC" ? `mock_seat_${crypto.randomUUID()}` : null;
    }

    const db = await ensureDatabase();
    let appointment: Appointment | null = null;
    for (const laneId of state.openLaneIds) {
      const id = crypto.randomUUID();
      const candidate: Appointment = {
        id,
        calUid,
        calSeatUid,
        confirmation: confirmationNumber(),
        customerName,
        customerEmail,
        phone: payload.phone?.trim() ?? "",
        address: payload.address?.trim() ?? "",
        zip: payload.zip?.trim() ?? "",
        territoryId,
        repId,
        laneId,
        date,
        slot,
        startAt,
        endAt,
        status: "Scheduled",
        calStatus: "accepted",
        source: auth.actor.id === "voice-agent" ? "voice-agent" : "calendar-ui",
        syncState: territoryId === "SAC" && integration.mode === "live" && !calSeatUid ? "seat-id-pending" : "synced",
        correlationId,
      };
      try {
        const inserted = await db
          .prepare(
            `INSERT INTO appointments (
             id,cal_uid,cal_seat_uid,external_key,confirmation,customer_name,customer_email,
             phone,address,zip,territory_id,rep_id,lane_id,date,slot,start_at,end_at,status,
             cal_status,source,sync_state,correlation_id
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT DO NOTHING RETURNING id`,
          )
          .bind(
            candidate.id,
            candidate.calUid,
            candidate.calSeatUid,
            candidate.calSeatUid || (candidate.territoryId === "SAC" ? `${candidate.calUid}:${candidate.customerEmail}` : candidate.calUid),
            candidate.confirmation,
            candidate.customerName,
            candidate.customerEmail,
            candidate.phone,
            candidate.address,
            candidate.zip,
            candidate.territoryId,
            candidate.repId || null,
            candidate.laneId,
            candidate.date,
            candidate.slot,
            candidate.startAt,
            candidate.endAt,
            candidate.status,
            candidate.calStatus,
            candidate.source,
            candidate.syncState,
            candidate.correlationId,
          )
          .first<{ id: string }>();
        if (inserted) {
          appointment = candidate;
          break;
        }
      } catch (error) {
        if (error instanceof Error && /rep|constraint|unique/i.test(error.message) && repId) {
          throw new ResponseError("The selected team member was assigned elsewhere at the same time", 409);
        }
        throw error;
      }
    }
    if (!appointment) throw new ResponseError("This time was just claimed by another booking", 409);
    rollback = null;
    await writeAudit({
      actorId: auth.actor.id,
      actorEmail: auth.actor.email,
      action: "appointment.created",
      entityType: "appointment",
      entityId: appointment.id,
      detail: {
        confirmation: appointment.confirmation,
        territoryId,
        repId: appointment.repId || null,
        source: appointment.source,
      },
      correlationId,
    });
    const response = { appointment };
    await finishIdempotentOperation(idempotencyKey, response);
    return Response.json(response, { status: 201 });
  } catch (error) {
    if (rollback) {
      await cancelCalBooking(
        rollback.territoryId,
        rollback.uid,
        "Rollback: Eagle Shield could not save the booking",
        rollback.seatUid,
      ).catch(() => undefined);
    }
    await failIdempotentOperation(idempotencyKey);
    return Response.json(
      { error: error instanceof Error ? error.message : "The appointment could not be saved" },
      { status: error instanceof ResponseError ? error.status : 500 },
    );
  }
}
