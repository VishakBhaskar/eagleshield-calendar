import {
  beginIdempotentOperation,
  ensureDatabase,
  failIdempotentOperation,
  finishIdempotentOperation,
  getAppointment,
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
  rescheduleCalBooking,
  seatUidFor,
} from "@/lib/cal";
import {
  addDays,
  addMinutes,
  computeCellState,
  toUtcIso,
  weekday,
  zonedDateParts,
} from "@/lib/domain.mjs";
import type { Rep, TerritoryId } from "@/lib/types";

type RouteContext = { params: Promise<{ id: string }> };
type UpdateInput = {
  action?: "cancel" | "reschedule" | "assign";
  reason?: string;
  territoryId?: TerritoryId;
  date?: string;
  slot?: string;
  repId?: string | null;
};

class UpdateError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function eligible(rep: Rep, territoryId: TerritoryId) {
  return territoryId === "SAC" ? rep.sacramentoEligible : rep.eastBayEligible;
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireActor(request, ["master_admin", "manager", "staff"]);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || crypto.randomUUID();
  const previous = await getIdempotentResponse(idempotencyKey);
  if (previous) return Response.json(previous);
  if (!(await beginIdempotentOperation(idempotencyKey, "appointment.update"))) {
    return Response.json({ error: "This update is already processing" }, { status: 409 });
  }
  try {
    const appointment = await getAppointment(id);
    if (!appointment) throw new UpdateError("Appointment not found", 404);
    const payload = (await request.json()) as UpdateInput;
    const db = await ensureDatabase();
    const reason = payload.reason?.trim() || "Updated by Eagle Shield team";

    if (payload.action === "assign") {
      const snapshot = await readSnapshot(appointment.date, appointment.date);
      const nextRepId = payload.repId?.trim() ?? "";
      if (nextRepId) {
        const rep = snapshot.reps.find((item) => item.id === nextRepId && item.active);
        if (!rep || !eligible(rep, appointment.territoryId)) {
          throw new UpdateError("That team member is not eligible for this location", 409);
        }
        const conflict = snapshot.appointments.some(
          (item) =>
            item.id !== appointment.id &&
            item.status !== "Cancelled" &&
            item.repId === nextRepId &&
            item.startAt === appointment.startAt,
        );
        if (conflict) throw new UpdateError("That team member already has an appointment at this time", 409);
      }
      await db.prepare("UPDATE appointments SET rep_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(nextRepId || null, appointment.id).run();
      const updated = { ...appointment, repId: nextRepId };
      await writeAudit({
        actorId: auth.actor.id,
        actorEmail: auth.actor.email,
        action: "appointment.assigned",
        entityType: "appointment",
        entityId: appointment.id,
        detail: { from: appointment.repId || null, to: nextRepId || null },
        correlationId: appointment.correlationId,
      });
      const response = { appointment: updated };
      await finishIdempotentOperation(idempotencyKey, response);
      return Response.json(response);
    }

    const integration = integrationStatus();
    if (integration.mode === "live" && !integration.healthy) {
      throw new UpdateError(integration.message, 503);
    }
    if (payload.action === "cancel") {
      if (appointment.status !== "Cancelled" && integration.mode === "live") {
        if (!appointment.calUid) throw new UpdateError("Cal.com booking UID is missing", 409);
        await cancelCalBooking(
          appointment.territoryId,
          appointment.calUid,
          reason,
          appointment.calSeatUid,
        );
      }
      await db
        .prepare(
          `UPDATE appointments SET status='Cancelled',cal_status='cancelled',
           updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        )
        .bind(appointment.id)
        .run();
      const updated = { ...appointment, status: "Cancelled" as const, calStatus: "cancelled" };
      await writeAudit({
        actorId: auth.actor.id,
        actorEmail: auth.actor.email,
        action: "appointment.cancelled",
        entityType: "appointment",
        entityId: appointment.id,
        detail: { reason },
        correlationId: appointment.correlationId,
      });
      const response = { appointment: updated };
      await finishIdempotentOperation(idempotencyKey, response);
      return Response.json(response);
    }

    if (payload.action !== "reschedule") throw new UpdateError("Unknown appointment action", 400);
    const territoryId = payload.territoryId ?? appointment.territoryId;
    const date = payload.date ?? "";
    const slot = payload.slot ?? "";
    if (!(territoryId === "SAC" || territoryId === "EB") || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new UpdateError("A valid location and date are required", 400);
    }
    const snapshot = await readSnapshot(date, date);
    if (!snapshot.settings.slots.includes(slot)) throw new UpdateError("Select a valid time", 400);
    if (date < zonedDateParts(new Date().toISOString(), snapshot.settings.timeZone).date) {
      throw new UpdateError("Past dates cannot be booked", 400);
    }
    if ([0, 6].includes(weekday(date))) throw new UpdateError("Weekends are closed", 400);
    const state = computeCellState({
      territoryId,
      date,
      slot,
      lanes: snapshot.lanes,
      reps: snapshot.reps,
      appointments: snapshot.appointments.filter((item) => item.id !== appointment.id),
      blocks: snapshot.blocks,
      settings: snapshot.settings,
      now: new Date().toISOString(),
    });
    if (!state.openLaneIds.length) throw new UpdateError("The requested location and time are full", 409);
    let repId = payload.repId === undefined ? appointment.repId : payload.repId?.trim() ?? "";
    if (repId) {
      const rep = snapshot.reps.find((item) => item.id === repId && item.active);
      if (!rep || !eligible(rep, territoryId) || !state.freeRepIds.includes(repId)) repId = "";
    }
    const startAt = toUtcIso(date, slot, snapshot.settings.timeZone);
    const endAt = addMinutes(startAt, snapshot.settings.appointmentDuration);
    let nextCalUid = appointment.calUid;
    let nextSeatUid = appointment.calSeatUid;
    let replacementCreated = false;

    if (integration.mode === "live") {
      if (!appointment.calUid) throw new UpdateError("Cal.com booking UID is missing", 409);
      const slots = await getAvailableSlots({
        territoryId,
        start: date,
        end: addDays(date, 1),
        timeZone: snapshot.settings.timeZone,
        bookingUidToReschedule:
          territoryId === appointment.territoryId ? appointment.calUid : undefined,
      });
      const available = Object.values(slots)
        .flat()
        .some((candidate) => new Date(candidate.start).toISOString() === startAt);
      if (!available) throw new UpdateError("Cal.com reports that the requested time is full", 409);
      if (territoryId === appointment.territoryId) {
        const result = await rescheduleCalBooking(territoryId, appointment.calUid, {
          start: startAt,
          reason,
          rescheduledBy: auth.actor.email || undefined,
          seatUid: appointment.calSeatUid,
        });
        nextCalUid = result.uid;
        nextSeatUid = seatUidFor(result, appointment.customerEmail) ?? appointment.calSeatUid;
      } else {
        if (!appointment.customerEmail) throw new UpdateError("Customer email is required to change location", 400);
        const replacement = await createCalBooking(territoryId, {
          start: startAt,
          attendee: {
            name: appointment.customerName,
            email: appointment.customerEmail,
            phoneNumber: appointment.phone || undefined,
            timeZone: snapshot.settings.timeZone,
            language: "en",
          },
          bookingFieldsResponses: { serviceAddress: appointment.address, zip: appointment.zip },
          metadata: {
            correlation_id: appointment.correlationId,
            replaces_uid: appointment.calUid,
            territory: territoryId,
            source: "calendar-ui",
          },
        });
        nextCalUid = replacement.uid;
        nextSeatUid = seatUidFor(replacement, appointment.customerEmail) ?? null;
        if (territoryId === "SAC" && !nextSeatUid) {
          const hydrated = await getCalBooking(territoryId, replacement.uid);
          nextSeatUid = seatUidFor(hydrated, appointment.customerEmail) ?? null;
        }
        replacementCreated = true;
        try {
          await cancelCalBooking(
            appointment.territoryId,
            appointment.calUid,
            `Moved to ${territoryId}: ${reason}`,
            appointment.calSeatUid,
          );
        } catch (error) {
          await cancelCalBooking(territoryId, replacement.uid, "Rollback: original booking remains", nextSeatUid)
            .catch(() => undefined);
          throw error;
        }
      }
    }

    const nextLane = state.openLaneIds[0];
    try {
      await db
        .prepare(
          `UPDATE appointments SET cal_uid=?,cal_seat_uid=?,external_key=?,territory_id=?,rep_id=?,
           lane_id=?,date=?,slot=?,start_at=?,end_at=?,status='Scheduled',cal_status='accepted',
           updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        )
        .bind(
          nextCalUid,
          nextSeatUid,
          nextSeatUid || (territoryId === "SAC" ? `${nextCalUid}:${appointment.customerEmail}` : nextCalUid),
          territoryId,
          repId || null,
          nextLane,
          date,
          slot,
          startAt,
          endAt,
          appointment.id,
        )
        .run();
    } catch (error) {
      if (replacementCreated && nextCalUid) {
        await cancelCalBooking(territoryId, nextCalUid, "Rollback: database conflict", nextSeatUid)
          .catch(() => undefined);
      }
      throw error;
    }
    const updated = {
      ...appointment,
      calUid: nextCalUid,
      calSeatUid: nextSeatUid,
      territoryId,
      repId,
      laneId: nextLane,
      date,
      slot,
      startAt,
      endAt,
      status: "Scheduled" as const,
      calStatus: "accepted",
    };
    await writeAudit({
      actorId: auth.actor.id,
      actorEmail: auth.actor.email,
      action: "appointment.rescheduled",
      entityType: "appointment",
      entityId: appointment.id,
      detail: {
        from: { territoryId: appointment.territoryId, date: appointment.date, slot: appointment.slot },
        to: { territoryId, date, slot, repId: repId || null },
        reason,
      },
      correlationId: appointment.correlationId,
    });
    const response = { appointment: updated };
    await finishIdempotentOperation(idempotencyKey, response);
    return Response.json(response);
  } catch (error) {
    await failIdempotentOperation(idempotencyKey);
    return Response.json(
      { error: error instanceof Error ? error.message : "Update failed" },
      { status: error instanceof UpdateError ? error.status : 500 },
    );
  }
}
