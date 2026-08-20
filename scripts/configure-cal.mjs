const CAL_API_VERSION = "2024-06-14";
const EXPECTED_FIELDS = ["serviceAddress", "zip"];
const REQUIRED_TRIGGERS = [
  "BOOKING_CREATED",
  "BOOKING_REQUESTED",
  "BOOKING_RESCHEDULED",
  "BOOKING_CANCELLED",
  "BOOKING_REJECTED",
];
const appUrl = process.env.APP_URL?.replace(/\/$/, "");

const locations = [
  {
    name: "Sacramento",
    apiKey: process.env.CAL_SAC_API_KEY,
    eventTypeId: process.env.CAL_SAC_EVENT_TYPE_ID,
    webhookSecret: process.env.CAL_SAC_WEBHOOK_SECRET,
    seats: 2,
  },
  {
    name: "East Bay",
    apiKey: process.env.CAL_EB_API_KEY,
    eventTypeId: process.env.CAL_EB_EVENT_TYPE_ID,
    webhookSecret: process.env.CAL_EB_WEBHOOK_SECRET,
    seats: 1,
  },
];

function assertConfiguration(location) {
  if (!location.apiKey || !location.eventTypeId || !location.webhookSecret || !appUrl) {
    throw new Error(`${location.name} Cal credentials, webhook secret, event type ID, and APP_URL are required.`);
  }
}

async function calRequest(location, method, body, path = `/event-types/${location.eventTypeId}`) {
  const response = await fetch(`https://api.cal.com/v2${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${location.apiKey}`,
      "cal-api-version": CAL_API_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.message || `HTTP ${response.status}`;
    throw new Error(`${location.name} Cal configuration failed: ${detail}`);
  }
  return payload.data;
}

for (const location of locations) {
  assertConfiguration(location);
  await calRequest(location, "PATCH", {
    bookingFields: [
      {
        type: "phone",
        label: "Phone number",
        slug: "attendeePhoneNumber",
        required: false,
      },
      {
        type: "address",
        label: "Service address",
        placeholder: "Street address, city, state",
        required: true,
        slug: "serviceAddress",
      },
      {
        type: "text",
        label: "ZIP code",
        placeholder: "ZIP code",
        required: true,
        slug: "zip",
      },
    ],
    locations: [
      {
        type: "address",
        address: "On-site at the customer's service address",
        public: true,
      },
    ],
  });

  const configured = await calRequest(location, "GET");
  const fieldIdentifiers = configured.bookingFields
    .filter((field) => !field.isDefault)
    .map((field) => field.slug || field.identifier);
  const missingFields = EXPECTED_FIELDS.filter((field) => !fieldIdentifiers.includes(field));
  const phoneField = configured.bookingFields.find((field) => field.slug === "attendeePhoneNumber");
  const configuredLocation = configured.locations?.[0];
  if (missingFields.length || !phoneField || phoneField.hidden || configuredLocation?.type !== "address") {
    throw new Error(`${location.name} verification failed after Cal accepted the update.`);
  }
  if (configured.seats?.seatsPerTimeSlot !== location.seats) {
    throw new Error(`${location.name} seat capacity changed unexpectedly.`);
  }

  const webhooks = await calRequest(
    location,
    "GET",
    undefined,
    `/event-types/${location.eventTypeId}/webhooks?take=250`,
  );
  const webhook = webhooks.find((candidate) =>
    candidate.active &&
    candidate.subscriberUrl === `${appUrl}/api/webhooks/cal` &&
    candidate.secret === location.webhookSecret &&
    !candidate.payloadTemplate,
  );
  const missingTriggers = REQUIRED_TRIGGERS.filter((trigger) => !webhook?.triggers?.includes(trigger));
  if (!webhook || missingTriggers.length) {
    const diagnostics = webhooks.map((candidate) => ({
      active: candidate.active,
      subscriberUrl: candidate.subscriberUrl,
      secretMatches: candidate.secret === location.webhookSecret,
      hasCustomPayload: Boolean(candidate.payloadTemplate),
      triggers: candidate.triggers,
    }));
    throw new Error(`${location.name} webhook verification failed: ${JSON.stringify({ missingTriggers, diagnostics })}`);
  }
  console.log(`${location.name} Cal event type configured and verified.`);
}
