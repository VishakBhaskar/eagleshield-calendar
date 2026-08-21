import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const appPort = 3100;
const calPort = 4100;
const appBase = `http://127.0.0.1:${appPort}`;
const calBase = `http://127.0.0.1:${calPort}`;

async function stageStandaloneAssets() {
  await cp(
    fileURLToPath(new URL("../.next/static", import.meta.url)),
    fileURLToPath(new URL("../.next/standalone/.next/static", import.meta.url)),
    { recursive: true },
  );
  await cp(
    fileURLToPath(new URL("../public", import.meta.url)),
    fileURLToPath(new URL("../.next/standalone/public", import.meta.url)),
    { recursive: true },
  );
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function createFakeCal() {
  const groups = new Map();
  const capacities = { SAC: 2, EB: 1 };
  const eventTypes = { SAC: "101", EB: "201" };
  const state = { unsafeSacramentoCancels: 0, creates: 0, cancels: 0, slotQueries: [] };

  const territoryFromRequest = (request, url) => {
    const key = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (key === "cal_sac_test" || url.searchParams.get("eventTypeId") === "101") return "SAC";
    if (key === "cal_eb_test" || url.searchParams.get("eventTypeId") === "201") return "EB";
    return null;
  };
  const keyFor = (territory, start) => `${territory}|${start}`;
  const booking = (group, attendees = group.seats, metadata = {}) => ({
    id: 1,
    uid: group.uid,
    status: "accepted",
    start: group.start,
    end: group.end,
    eventTypeId: Number(eventTypes[group.territory]),
    attendees: attendees.map((seat) => ({ ...seat.attendee, seatUid: seat.seatUid })),
    metadata,
    bookingFieldsResponses: {},
  });
  const dateRange = (from, to) => {
    const values = [];
    for (let date = from.slice(0, 10), end = to.slice(0, 10); date < end; ) {
      values.push(date);
      const next = new Date(`${date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      date = next.toISOString().slice(0, 10);
    }
    return values;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", calBase);
      if (url.pathname === "/__state") {
        return json(response, 200, {
          ...state,
          groups: [...groups.values()].map((group) => ({
            territory: group.territory,
            start: group.start,
            attendees: group.seats.map((seat) => ({ email: seat.attendee.email, name: seat.attendee.name, seatUid: seat.seatUid })),
          })),
        });
      }
      const territory = territoryFromRequest(request, url);
      if (!territory) return json(response, 401, { status: "error", error: { message: "Bad API key" } });

      const eventMatch = url.pathname.match(/^\/v2\/event-types\/(\d+)$/);
      if (request.method === "GET" && eventMatch) {
        if (eventMatch[1] !== eventTypes[territory]) return json(response, 404, { status: "error" });
        return json(response, 200, {
          status: "success",
          data: {
            id: Number(eventTypes[territory]),
            seats: territory === "SAC" ? { seatsPerTimeSlot: 2 } : undefined,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/v2/slots") {
        state.slotQueries.push({
          territory,
          start: url.searchParams.get("start"),
          end: url.searchParams.get("end"),
        });
        const data = {};
        for (const date of dateRange(url.searchParams.get("start"), url.searchParams.get("end"))) {
          if ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
          const slots = [];
          for (const time of ["10:00", "13:00", "16:00"]) {
            const start = new Date(`${date}T${time}:00-08:00`).toISOString();
            const group = groups.get(keyFor(territory, start));
            if ((group?.seats.length ?? 0) < capacities[territory]) {
              slots.push({
                start,
                end: new Date(new Date(start).getTime() + 120 * 60_000).toISOString(),
                attendeesCount: group?.seats.length ?? 0,
                seatsBooked: group?.seats.length ?? 0,
                seatsRemaining: capacities[territory] - (group?.seats.length ?? 0),
                seatsTotal: capacities[territory],
                bookingUid: group?.uid,
              });
            }
          }
          if (slots.length) data[date] = slots;
        }
        return json(response, 200, { status: "success", data });
      }

      if (request.method === "POST" && url.pathname === "/v2/bookings") {
        const input = await body(request);
        const inferred = String(input.eventTypeId) === "101" ? "SAC" : String(input.eventTypeId) === "201" ? "EB" : territory;
        if (inferred !== territory) return json(response, 400, { status: "error", error: { message: "Event type mismatch" } });
        const groupKey = keyFor(territory, input.start);
        let group = groups.get(groupKey);
        if (!group) {
          group = {
            uid: `booking_${crypto.randomUUID()}`,
            territory,
            start: input.start,
            end: new Date(new Date(input.start).getTime() + 120 * 60_000).toISOString(),
            seats: [],
          };
          groups.set(groupKey, group);
        }
        if (group.seats.length >= capacities[territory]) {
          return json(response, 409, { status: "error", error: { message: "This slot is full" } });
        }
        const seat = {
          seatUid: `seat_${crypto.randomUUID()}`,
          attendee: input.attendee,
          metadata: input.metadata ?? {},
        };
        group.seats.push(seat);
        state.creates += 1;
        return json(response, 201, { status: "success", data: { ...booking(group, [seat], seat.metadata), seatUid: seat.seatUid } });
      }

      const bookingMatch = url.pathname.match(/^\/v2\/bookings\/([^/]+)$/);
      if (request.method === "GET" && bookingMatch) {
        const group = [...groups.values()].find((candidate) => candidate.uid === decodeURIComponent(bookingMatch[1]));
        return group
          ? json(response, 200, { status: "success", data: booking(group) })
          : json(response, 404, { status: "error", error: { message: "Not found" } });
      }

      const cancelMatch = url.pathname.match(/^\/v2\/bookings\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const input = await body(request);
        const group = [...groups.values()].find((candidate) => candidate.uid === decodeURIComponent(cancelMatch[1]));
        if (!group) return json(response, 404, { status: "error", error: { message: "Not found" } });
        if (territory === "SAC") {
          if (!input.seatUid) {
            state.unsafeSacramentoCancels += 1;
            return json(response, 400, { status: "error", error: { message: "seatUid required" } });
          }
          group.seats = group.seats.filter((seat) => seat.seatUid !== input.seatUid);
        } else {
          group.seats = [];
        }
        state.cancels += 1;
        return json(response, 200, { status: "success", data: booking(group) });
      }

      const rescheduleMatch = url.pathname.match(/^\/v2\/bookings\/([^/]+)\/reschedule$/);
      if (request.method === "POST" && rescheduleMatch) {
        const input = await body(request);
        const oldGroup = [...groups.values()].find((candidate) => candidate.uid === decodeURIComponent(rescheduleMatch[1]));
        if (!oldGroup) return json(response, 404, { status: "error" });
        const seat = territory === "SAC"
          ? oldGroup.seats.find((candidate) => candidate.seatUid === input.seatUid)
          : oldGroup.seats[0];
        if (!seat) return json(response, 400, { status: "error", error: { message: "Seat missing" } });
        oldGroup.seats = oldGroup.seats.filter((candidate) => candidate !== seat);
        const targetKey = keyFor(territory, input.start);
        let target = groups.get(targetKey);
        if (!target) {
          target = { uid: `booking_${crypto.randomUUID()}`, territory, start: input.start, end: new Date(new Date(input.start).getTime() + 120 * 60_000).toISOString(), seats: [] };
          groups.set(targetKey, target);
        }
        if (target.seats.length >= capacities[territory]) return json(response, 409, { status: "error" });
        target.seats.push(seat);
        return json(response, 201, { status: "success", data: { ...booking(target, [seat], seat.metadata), seatUid: seat.seatUid } });
      }

      if (request.method === "GET" && url.pathname === "/v2/bookings") {
        const data = [...groups.values()]
          .filter((group) => group.territory === territory && group.seats.length)
          .map((group) => booking(group));
        return json(response, 200, { status: "success", data, pagination: { hasMore: false, nextCursor: null } });
      }
      return json(response, 404, { status: "error", error: { message: `Unknown ${request.method} ${url.pathname}` } });
    } catch (error) {
      return json(response, 500, { status: "error", error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  return { server, state };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  await Promise.race([
    new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForApp(getExitCode) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const exitCode = getExitCode();
    if (exitCode !== null) throw new Error(`Application exited with ${exitCode}`);
    try {
      const response = await fetch(`${appBase}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Application did not become ready");
}

async function login(email, password) {
  const response = await fetch(`${appBase}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function request(path, { cookie = "", expected = 200, ...init } = {}) {
  const response = await fetch(`${appBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${init.method ?? "GET"} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

test("Railway app, two Cal locations, seated holds, bulk blocks, auth, assignments, webhooks, and repair run end to end", { timeout: 60_000 }, async () => {
  await stageStandaloneAssets();
  const fakeCal = createFakeCal();
  await listen(fakeCal.server, calPort);
  const app = new Worker(fileURLToPath(new URL("support/standalone-worker.mjs", import.meta.url)), {
    env: {
      ...process.env,
      PORT: String(appPort),
      HOSTNAME: "127.0.0.1",
      ALLOW_IN_MEMORY_DB: "true",
      ALLOW_TEST_WEBHOOKS: "true",
      COOKIE_SECURE: "false",
      SESSION_SECRET: "e2e-session-secret-with-at-least-32-bytes",
      MASTER_ADMIN_EMAIL: "master@eagleshield.test",
      MASTER_ADMIN_PASSWORD: "MasterPassword!2026",
      CAL_MODE: "live",
      CAL_API_ROOT: `${calBase}/v2`,
      CAL_SAC_API_KEY: "cal_sac_test",
      CAL_SAC_EVENT_TYPE_ID: "101",
      CAL_SAC_WEBHOOK_SECRET: "sac-webhook-secret",
      CAL_EB_API_KEY: "cal_eb_test",
      CAL_EB_EVENT_TYPE_ID: "201",
      CAL_EB_WEBHOOK_SECRET: "eb-webhook-secret",
      CAL_HOLD_EMAIL: "calendar@eagleshield.test",
      VOICE_AGENT_SECRET: "voice-agent-e2e-secret",
      CRON_SECRET: "cron-e2e-secret",
    },
    stdout: true,
    stderr: true,
  });
  let appOutput = "";
  let appExitCode = null;
  app.once("exit", (code) => { appExitCode = code; });
  app.stdout.on("data", (chunk) => {
    appOutput += chunk.toString();
    process.stderr.write(chunk);
  });
  app.stderr.on("data", (chunk) => {
    appOutput += chunk.toString();
    process.stderr.write(chunk);
  });
  try {
    await waitForApp(() => appExitCode);
    const loginPage = await fetch(`${appBase}/login`);
    const loginHtml = await loginPage.text();
    assert.equal(loginPage.status, 200);
    assert.match(loginHtml, /Welcome back/);
    const cssPath = loginHtml.match(/href="([^"]+\.css[^"]*)/)?.[1];
    const scriptPath = loginHtml.match(/src="([^"]+\.js[^"]*)/)?.[1];
    assert.ok(cssPath, "login page includes its compiled stylesheet");
    assert.ok(scriptPath, "login page includes its client runtime");
    assert.equal((await fetch(new URL(cssPath, appBase))).status, 200);
    assert.equal((await fetch(new URL(scriptPath, appBase))).status, 200);
    await request("/api/calendar?from=2027-01-01&to=2027-01-31", { expected: 401 });
    assert.equal((await login("master@eagleshield.test", "wrong-password")).response.status, 401);
    const master = await login("master@eagleshield.test", "MasterPassword!2026");
    assert.equal(master.response.status, 200);
    assert.ok(master.cookie.startsWith("eagle_session="));

    const setup = await request("/api/setup/cal", { method: "POST", cookie: master.cookie, body: "{}" });
    assert.equal(setup.healthy, true);
    assert.equal(setup.locations.find((item) => item.territoryId === "SAC").seats, 2);
    const initialAvailability = await request("/api/calendar?from=2027-01-11&to=2027-01-18", { cookie: master.cookie });
    assert.equal(initialAvailability.providerAvailability.mode, "provider");
    assert.equal(initialAvailability.providerAvailability.slots.SAC["2027-01-15|16:00"], 2);
    assert.equal(initialAvailability.providerAvailability.slots.SAC["2027-01-16|10:00"], undefined);

    const createdUser = await request("/api/reps", {
      method: "POST",
      cookie: master.cookie,
      expected: 201,
      body: JSON.stringify({
        name: "Operations Manager",
        email: "manager@eagleshield.test",
        password: "ManagerPassword!2026",
        role: "manager",
        sacramentoEligible: true,
        eastBayEligible: true,
      }),
    });
    const manager = await login("manager@eagleshield.test", "ManagerPassword!2026");
    assert.equal(manager.response.status, 200);
    await request("/api/reps", {
      method: "POST",
      cookie: manager.cookie,
      expected: 403,
      body: JSON.stringify({ name: "Forbidden", email: "forbidden@example.com", password: "ForbiddenPass!2026", role: "staff", sacramentoEligible: true }),
    });

    const bulk = await request("/api/blocks", {
      method: "POST",
      cookie: manager.cookie,
      expected: 201,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        territories: [{ territoryId: "SAC", seats: 1 }, { territoryId: "EB", seats: 1 }],
        fromDate: "2027-01-11",
        toDate: "2027-01-13",
        weekdays: [1, 2, 3],
        slots: ["13:00"],
        reason: "E2E holiday",
      }),
    });
    assert.equal(bulk.blockedSeats, 6);
    assert.equal(bulk.sync.synced, 6);
    const bulkReplay = await request("/api/blocks", {
      method: "POST",
      cookie: manager.cookie,
      headers: { "Idempotency-Key": "fixed-bulk-replay" },
      body: JSON.stringify({ territories: [{ territoryId: "SAC", seats: 1 }], fromDate: "2027-01-18", toDate: "2027-01-18", weekdays: [1], slots: ["10:00"], reason: "Replay" }),
      expected: 201,
    });
    const replayed = await request("/api/blocks", {
      method: "POST",
      cookie: manager.cookie,
      headers: { "Idempotency-Key": "fixed-bulk-replay" },
      body: JSON.stringify({ territories: [{ territoryId: "SAC", seats: 2 }], fromDate: "2027-01-18", toDate: "2027-01-18", weekdays: [1], slots: ["10:00"], reason: "Ignored" }),
      expected: 201,
    });
    assert.equal(replayed.ruleId, bulkReplay.ruleId);

    const firstSeat = await request("/api/appointments", {
      method: "POST",
      cookie: manager.cookie,
      expected: 201,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Sacramento One", customerEmail: "sac1@example.com", territoryId: "SAC", date: "2027-01-11", slot: "13:00" }),
    });
    await request("/api/appointments", {
      method: "POST",
      cookie: manager.cookie,
      expected: 409,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Sacramento Full", customerEmail: "sacfull@example.com", territoryId: "SAC", date: "2027-01-11", slot: "13:00" }),
    });
    for (const email of ["open1@example.com", "open2@example.com"]) {
      await request("/api/appointments", {
        method: "POST",
        cookie: manager.cookie,
        expected: 201,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ customerName: email, customerEmail: email, territoryId: "SAC", date: "2027-01-11", slot: "16:00" }),
      });
    }
    const lateFriday = await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 201, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Late Friday", customerEmail: "latefriday@example.com", territoryId: "SAC", date: "2027-01-15", slot: "16:00" }),
    });
    const calStateAfterLateBooking = await fetch(`${calBase}/__state`).then((response) => response.json());
    assert.ok(calStateAfterLateBooking.slotQueries.some((query) => query.start === "2027-01-15" && query.end === "2027-01-16"));
    await request(`/api/appointments/${lateFriday.appointment.id}`, {
      method: "PATCH", cookie: manager.cookie, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action: "reschedule", date: "2027-01-22", slot: "16:00" }),
    });
    await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 400, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Weekend", customerEmail: "weekend@example.com", territoryId: "SAC", date: "2027-01-16", slot: "10:00" }),
    });
    await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 409, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Third", customerEmail: "third@example.com", territoryId: "SAC", date: "2027-01-11", slot: "16:00" }),
    });

    const assignA = await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 201, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Assign A", customerEmail: "assigna@example.com", territoryId: "SAC", date: "2027-01-12", slot: "10:00" }),
    });
    const assignB = await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 201, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Assign B", customerEmail: "assignb@example.com", territoryId: "EB", date: "2027-01-12", slot: "10:00" }),
    });
    await request(`/api/appointments/${assignA.appointment.id}`, {
      method: "PATCH", cookie: manager.cookie, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action: "assign", repId: createdUser.repId }),
    });
    await request(`/api/appointments/${assignB.appointment.id}`, {
      method: "PATCH", cookie: manager.cookie, expected: 409, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action: "assign", repId: createdUser.repId }),
    });

    const voice = await request("/api/appointments", {
      method: "POST",
      expected: 201,
      headers: { Authorization: "Bearer voice-agent-e2e-secret", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Voice Booking", customerEmail: "voice@example.com", territoryId: "EB", date: "2027-01-13", slot: "10:00" }),
    });
    assert.equal(voice.appointment.repId, "");
    assert.equal(voice.appointment.source, "voice-agent");

    const direct = await fetch(`${calBase}/v2/bookings`, {
      method: "POST",
      headers: { authorization: "Bearer cal_eb_test", "content-type": "application/json" },
      body: JSON.stringify({ eventTypeId: 201, start: "2027-01-14T21:00:00.000Z", attendee: { name: "Webhook Customer", email: "webhook@example.com", timeZone: "America/Los_Angeles", language: "en" }, metadata: { source: "voice-agent" } }),
    }).then((response) => response.json());
    const webhookBody = JSON.stringify({ triggerEvent: "BOOKING_CREATED", createdAt: new Date().toISOString(), payload: direct.data });
    await request("/api/webhooks/cal", {
      method: "POST",
      headers: { "x-eagle-test-webhook": "true", "x-eagle-cal-territory": "EB" },
      body: webhookBody,
    });
    const duplicate = await request("/api/webhooks/cal", {
      method: "POST",
      headers: { "x-eagle-test-webhook": "true", "x-eagle-cal-territory": "EB" },
      body: webhookBody,
    });
    assert.match(JSON.stringify(duplicate), /"duplicate":true/, "duplicate webhook response");
    const failedWebhookBody = JSON.stringify({
      triggerEvent: "BOOKING_CANCELLED",
      createdAt: new Date().toISOString(),
      payload: { uid: "seatless-sacramento", eventTypeId: 101 },
    });
    await request("/api/webhooks/cal", {
      method: "POST", expected: 500,
      headers: { "x-eagle-test-webhook": "true", "x-eagle-cal-territory": "SAC" },
      body: failedWebhookBody,
    });
    await request("/api/webhooks/cal", {
      method: "POST", expected: 500,
      headers: { "x-eagle-test-webhook": "true", "x-eagle-cal-territory": "SAC" },
      body: failedWebhookBody,
    });
    const degradedHealth = await request("/api/health");
    assert.equal(degradedHealth.checks.failedWebhooks, 1);
    assert.equal(degradedHealth.checks.failedWebhookAttempts, 2);
    const snapshot = await request("/api/calendar?from=2027-01-11&to=2027-01-18", { cookie: manager.cookie });
    assert.ok(snapshot.appointments.some((appointment) => appointment.customerEmail === "webhook@example.com" && appointment.repId === ""));
    assert.equal(snapshot.blocks.filter((block) => block.ruleId === bulk.ruleId).length, 6);

    await request(`/api/appointments/${firstSeat.appointment.id}`, {
      method: "PATCH", cookie: manager.cookie, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action: "cancel", reason: "Seat-safe E2E cancellation" }),
    });
    const replacement = await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 201, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Sacramento Replacement", customerEmail: "replacement@example.com", territoryId: "SAC", date: "2027-01-11", slot: "13:00" }),
    });
    await request(`/api/blocks/${bulk.ruleId}`, { method: "DELETE", cookie: manager.cookie });
    const calStateAfterDelete = await fetch(`${calBase}/__state`).then((response) => response.json());
    const targetGroup = calStateAfterDelete.groups.find((group) => group.territory === "SAC" && group.start === "2027-01-11T21:00:00.000Z");
    assert.equal(targetGroup.attendees.length, 1);
    assert.equal(targetGroup.attendees[0].email, "replacement@example.com");
    assert.equal(calStateAfterDelete.unsafeSacramentoCancels, 0);

    await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 201, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Seat Restored", customerEmail: "restored@example.com", territoryId: "SAC", date: "2027-01-11", slot: "13:00" }),
    });
    await request("/api/appointments", {
      method: "POST", cookie: manager.cookie, expected: 409, headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ customerName: "Still Full", customerEmail: "stillfull@example.com", territoryId: "SAC", date: "2027-01-11", slot: "13:00" }),
    });

    const repair = await request("/api/cron/reconcile", {
      method: "POST",
      expected: 207,
      headers: { Authorization: "Bearer cron-e2e-secret" },
      body: "{}",
    });
    assert.equal(repair.mode, "live");
    assert.ok(repair.bookings.scanned > 0);
    assert.deepEqual(repair.webhooks, { scanned: 1, retried: 1, processed: 0, failed: 1 });
    const health = await request("/api/health");
    assert.equal(health.database, "ok");
    assert.equal(health.checks.failedWebhookAttempts, 3);

    await request("/api/auth/logout", { method: "POST", cookie: manager.cookie, body: "{}" });
    await request("/api/calendar?from=2027-01-01&to=2027-01-31", { cookie: manager.cookie, expected: 401 });
    assert.equal(replacement.appointment.territoryId, "SAC");
  } catch (error) {
    if (appOutput) process.stderr.write(`\nApplication output:\n${appOutput}\n`);
    throw error;
  } finally {
    if (appExitCode === null) await app.terminate();
    await close(fakeCal.server);
  }
});
