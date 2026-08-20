import {
  apiKeyFor,
  eventTypeIdFor,
  getRuntimeEnvironment,
  webhookSecretFor,
} from "@/db/runtime";
import type { TerritoryId } from "@/lib/types";

export class CalApiError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CalApiError";
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export function integrationStatus() {
  const runtime = getRuntimeEnvironment();
  if (runtime.CAL_MODE !== "live") {
    return { mode: "mock" as const, healthy: true, message: "Local calendar engine active" };
  }
  const missing: string[] = [];
  for (const territory of ["SAC", "EB"] as const) {
    if (!apiKeyFor(territory)) missing.push(`${territory} API key`);
    if (!eventTypeIdFor(territory)) missing.push(`${territory} event type`);
    if (!webhookSecretFor(territory)) missing.push(`${territory} webhook secret`);
  }
  return missing.length
    ? {
        mode: "live" as const,
        healthy: false,
        message: `Cal.com configuration missing: ${missing.join(", ")}`,
      }
    : { mode: "live" as const, healthy: true, message: "Both Cal.com locations connected" };
}

async function calRequest<T>(
  territoryId: TerritoryId,
  path: string,
  version: string,
  init: RequestInit = {},
  unwrapData = true,
): Promise<T> {
  const apiKey = apiKeyFor(territoryId);
  if (!apiKey) throw new CalApiError(`${territoryId} Cal.com API key is not configured`, 503);
  const root = getRuntimeEnvironment().CAL_API_ROOT ?? "https://api.cal.com/v2";
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${root}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "cal-api-version": version,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        data?: T;
        error?: { message?: string } | string;
        message?: string;
      };
      if (response.ok && payload.status !== "error") {
        return (unwrapData ? payload.data ?? payload : payload) as T;
      }
      const message =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.message ?? payload.message ?? `Cal.com returned ${response.status}`;
      const error = new CalApiError(message, response.status);
      if (!error.retryable || attempt === 2) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof CalApiError && !error.retryable) throw error;
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new CalApiError("Cal.com request failed", 503);
}

export type CalAttendee = {
  id?: number;
  name: string;
  email: string;
  phoneNumber?: string;
  seatUid?: string;
};

export interface CalBookingInput {
  eventTypeId?: string;
  start: string;
  attendee: {
    name: string;
    email: string;
    phoneNumber?: string;
    timeZone: string;
    language: string;
  };
  bookingFieldsResponses?: Record<string, string>;
  metadata: Record<string, string>;
  lengthInMinutes?: number;
}

export interface CalBooking {
  id: number;
  uid: string;
  seatUid?: string;
  status: string;
  start: string;
  end: string;
  eventTypeId?: number;
  attendees?: CalAttendee[];
  bookingFieldsResponses?: Record<string, string>;
  rescheduledFromUid?: string;
  rescheduledToUid?: string;
  metadata?: Record<string, string>;
}

export function seatUidFor(booking: CalBooking, email?: string) {
  if (booking.seatUid) return booking.seatUid;
  const attendees = booking.attendees ?? [];
  return (
    attendees.find((attendee) => email && attendee.email.toLowerCase() === email.toLowerCase())
      ?.seatUid ?? attendees.find((attendee) => attendee.seatUid)?.seatUid
  );
}

export async function getAvailableSlots(input: {
  territoryId: TerritoryId;
  start: string;
  end: string;
  timeZone: string;
  bookingUidToReschedule?: string;
}) {
  const eventTypeId = eventTypeIdFor(input.territoryId);
  if (!eventTypeId) throw new CalApiError("Cal.com event type is not configured", 503);
  const query = new URLSearchParams({
    eventTypeId,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone,
    format: "range",
  });
  if (input.bookingUidToReschedule) {
    query.set("bookingUidToReschedule", input.bookingUidToReschedule);
  }
  return calRequest<
    Record<string, Array<{ start: string; end?: string; attendeesCount?: number; bookingUid?: string }>>
  >(input.territoryId, `/slots?${query.toString()}`, "2024-09-04");
}

export function createCalBooking(territoryId: TerritoryId, input: CalBookingInput) {
  const eventTypeId = input.eventTypeId ?? eventTypeIdFor(territoryId);
  if (!eventTypeId) throw new CalApiError("Cal.com event type is not configured", 503);
  return calRequest<CalBooking>(territoryId, "/bookings", "2026-02-25", {
    method: "POST",
    body: JSON.stringify({ ...input, eventTypeId: Number(eventTypeId) }),
  });
}

export function getCalBooking(territoryId: TerritoryId, uid: string) {
  return calRequest<CalBooking>(
    territoryId,
    `/bookings/${encodeURIComponent(uid)}`,
    "2026-02-25",
  );
}

export function cancelCalBooking(
  territoryId: TerritoryId,
  uid: string,
  reason: string,
  seatUid?: string | null,
) {
  if (territoryId === "SAC" && !seatUid) {
    throw new CalApiError(
      "Sacramento cancellation was stopped because its seat UID is missing; cancelling by booking UID could cancel other customers.",
      409,
    );
  }
  return calRequest<CalBooking>(
    territoryId,
    `/bookings/${encodeURIComponent(uid)}/cancel`,
    "2026-02-25",
    {
      method: "POST",
      body: JSON.stringify(
        seatUid ? { seatUid, cancellationReason: reason } : { cancellationReason: reason },
      ),
    },
  );
}

export function rescheduleCalBooking(
  territoryId: TerritoryId,
  uid: string,
  input: { start: string; reason: string; rescheduledBy?: string; seatUid?: string | null },
) {
  return calRequest<CalBooking>(
    territoryId,
    `/bookings/${encodeURIComponent(uid)}/reschedule`,
    "2026-02-25",
    {
      method: "POST",
      body: JSON.stringify({
        start: input.start,
        reschedulingReason: input.reason,
        rescheduledBy: input.rescheduledBy,
        ...(input.seatUid ? { seatUid: input.seatUid } : {}),
      }),
    },
  );
}

export async function listCalBookings(territoryId: TerritoryId) {
  const bookings: CalBooking[] = [];
  for (const status of ["upcoming", "unconfirmed", "cancelled"] as const) {
    let cursor = "";
    do {
      const query = new URLSearchParams({ status });
      if (cursor) query.set("cursor", cursor);
      const page = await calRequest<{
        status: string;
        data: CalBooking[];
        pagination: { hasMore: boolean; nextCursor: string | null };
      }>(territoryId, `/bookings?${query.toString()}`, "2026-05-01", {}, false);
      bookings.push(...(page.data ?? []));
      cursor = page.pagination?.hasMore ? page.pagination.nextCursor ?? "" : "";
    } while (cursor);
  }
  return bookings;
}

async function validSignature(rawBody: string, signature: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyCalWebhook(rawBody: string, signature: string | null) {
  if (!signature) return null;
  for (const territory of ["SAC", "EB"] as const) {
    const secret = webhookSecretFor(territory);
    if (secret && (await validSignature(rawBody, signature, secret))) return territory;
  }
  return null;
}

export async function validateCalConfiguration() {
  const results = await Promise.allSettled(
    (["SAC", "EB"] as const).map(async (territoryId) => {
      const eventTypeId = eventTypeIdFor(territoryId);
      if (!eventTypeId) throw new Error(`${territoryId} event type ID is missing`);
      const eventType = await calRequest<{ id: number; seats?: { seatsPerTimeSlot?: number } }>(
        territoryId,
        `/event-types/${encodeURIComponent(eventTypeId)}`,
        "2024-06-14",
      );
      const seats = eventType.seats?.seatsPerTimeSlot ?? (territoryId === "EB" ? 1 : 0);
      if (territoryId === "SAC" && seats !== 2) {
        throw new Error(`Sacramento must have exactly 2 seats; Cal.com reports ${seats}`);
      }
      return { territoryId, eventTypeId, seats };
    }),
  );
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? { ...result.value, healthy: true }
      : {
          territoryId: (["SAC", "EB"] as const)[index],
          healthy: false,
          error: result.reason instanceof Error ? result.reason.message : "Validation failed",
        },
  );
}
