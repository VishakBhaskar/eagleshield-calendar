import { getRuntimeEnvironment, territoryForEventType } from "@/db/runtime";
import { verifyCalWebhook } from "@/lib/cal";
import {
  applyCalWebhook,
  beginCalWebhookAttempt,
  bookingFromWebhookPayload,
  completeCalWebhookAttempt,
  failCalWebhookAttempt,
  type CalWebhookPayload,
} from "@/lib/cal-webhooks";
import type { TerritoryId } from "@/lib/types";

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const booking = bookingFromWebhookPayload(webhook.payload ?? {});
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
  const attempt = await beginCalWebhookAttempt({
    fingerprint,
    trigger,
    bookingUid: booking.uid || null,
    rawBody,
  });
  if (attempt !== "claimed") {
    return Response.json({ received: true, duplicate: true, processing: attempt === "processing" });
  }

  try {
    await applyCalWebhook(webhook, booking, verifiedTerritory);
    await completeCalWebhookAttempt(fingerprint);
    return Response.json({ received: true });
  } catch (error) {
    const message = await failCalWebhookAttempt(fingerprint, error);
    return Response.json({ error: message }, { status: 500 });
  }
}
