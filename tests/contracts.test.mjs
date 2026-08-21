import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Postgres schema has authentication, concurrency, and idempotency guards", async () => {
  const schema = await readFile(new URL("db/schema.sql", root), "utf8");
  for (const token of [
    "CREATE TABLE IF NOT EXISTS users",
    "CREATE TABLE IF NOT EXISTS sessions",
    "idx_appointments_active_rep_time",
    "idx_appointments_active_lane_time",
    "idx_blocks_active_lane_time",
    "idx_webhook_fingerprint",
    "idx_appointments_external_key",
    "attempt_count INTEGER",
    "error_message TEXT",
  ]) assert.match(schema, new RegExp(token));
  assert.doesNotMatch(schema, /event_type_bindings|cal_resource_user_id|cal_user_id/);
});

test("mutations are authenticated and Cal credentials remain server-side", async () => {
  const paths = [
    "app/api/appointments/route.ts",
    "app/api/appointments/[id]/route.ts",
    "app/api/blocks/route.ts",
    "app/api/blocks/[ruleId]/route.ts",
    "app/api/reps/route.ts",
    "app/api/reps/[id]/route.ts",
    "app/api/config/cutoff/route.ts",
    "app/api/setup/cal/route.ts",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.match(source, /await requireActor\(request/, path);
  }
  const client = await readFile(new URL("app/calendar-app.tsx", root), "utf8");
  assert.doesNotMatch(client, /CAL_(?:SAC|EB)_API_KEY|api\.cal\.com/);
});

test("Cal integration uses two standalone location accounts and safe seated cancellation", async () => {
  const cal = await readFile(new URL("lib/cal.ts", root), "utf8");
  const runtime = await readFile(new URL("db/runtime.ts", root), "utf8");
  assert.match(runtime, /CAL_SAC_API_KEY/);
  assert.match(runtime, /CAL_EB_API_KEY/);
  assert.match(cal, /apiKeyFor/);
  assert.match(cal, /seatUid/);
  assert.match(cal, /Sacramento cancellation was stopped/);
  assert.doesNotMatch(cal, /CAL_TEAM_ID|createCalTeamEventType|addCalTeamMember/);
  assert.match(cal, /attempt < 3/);
  assert.match(cal, /addDays\(input\.to, 1\)/);
});

test("calendar availability and webhook failures fail closed and remain repairable", async () => {
  const calendar = await readFile(new URL("app/api/calendar/route.ts", root), "utf8");
  const client = await readFile(new URL("app/calendar-app.tsx", root), "utf8");
  const webhooks = await readFile(new URL("lib/cal-webhooks.ts", root), "utf8");
  assert.match(calendar, /getProviderAvailability/);
  assert.match(client, /showProviderBlock/);
  assert.doesNotMatch(client, /Closed in Cal\.com/);
  assert.match(client, /providerOpenSeats/);
  assert.match(webhooks, /state='failed'/);
  assert.match(webhooks, /attempt_count=attempt_count\+1/);
  assert.match(webhooks, /retryFailedCalWebhooks/);
});

test("calendar appointments and destructive actions use designed in-app modals", async () => {
  const client = await readFile(new URL("app/calendar-app.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.doesNotMatch(client, /window\.confirm/);
  for (const token of [
    'type: "appointment"',
    'type: "cancel-appointment"',
    'type: "remove-block"',
    "Appointment details",
    "Cancel appointment",
    "Remove block",
    "Reschedule",
  ]) assert.ok(client.includes(token), token);
  for (const selector of [
    ".appointment-seat",
    ".appointment-panel",
    ".confirm-panel",
    ".modal-close",
    ".btn.danger",
    ".blocked.blockseat",
  ]) assert.ok(css.includes(selector), selector);
});

test("bulk blocking supports ranges, weekdays, locations, times, and per-location seats", async () => {
  const blocks = await readFile(new URL("lib/blocks.ts", root), "utf8");
  const client = await readFile(new URL("app/calendar-app.tsx", root), "utf8");
  for (const token of ["fromDate", "toDate", "weekdays", "slots", "territories", "1_000"]) {
    assert.match(blocks, new RegExp(token));
  }
  for (const label of ["Block times in bulk", "Bulk block times", "Block both seats", "Appointment times"]) {
    assert.match(client, new RegExp(label));
  }
});

test("the preserved prototype surface remains available", async () => {
  const client = await readFile(new URL("app/calendar-app.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  for (const label of ["Calendar", "Scheduling", "Appointments Log", "Sacramento", "East Bay", "After-hours cutoff", "Conflict protection"]) {
    assert.match(client, new RegExp(label));
  }
  for (const selector of [".pill-tabs", ".terrblock", ".tb-sac", ".tb-eb", ".seatopen", ".sched", ".logwrap", ".modal"]) {
    assert.ok(css.includes(selector), selector);
  }
});

test("Railway image uses the Next standalone asset layout", async () => {
  const dockerfile = await readFile(new URL("Dockerfile", root), "utf8");
  const start = await readFile(new URL("scripts/start.mjs", root), "utf8");
  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.match(dockerfile, /\/app\/\.next\/standalone \.\//);
  assert.match(dockerfile, /\/app\/\.next\/static \.\/\.next\/static/);
  assert.match(dockerfile, /node scripts\/start\.mjs/);
  assert.doesNotMatch(dockerfile, /COPY --from=build \/app\/\.next \.\/\.next/);
  assert.match(start, /RECONCILE_INTERVAL_MS/);
  assert.match(start, /\/api\/cron\/reconcile/);
  assert.match(start, /response\.status === 409/);
  assert.match(start, /setInterval\(reconcile, intervalMs\)/);
  assert.match(readme, /Reconciliation runs inside the same Railway app service/);
  assert.doesNotMatch(readme, /create a second Railway service/);
});

test("login surface matches the Eagle Shield operations design", async () => {
  const page = await readFile(new URL("app/login/page.tsx", root), "utf8");
  const form = await readFile(new URL("app/login/login-form.tsx", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  for (const text of ["Operations workspace", "Sacramento", "East Bay", "Private workspace"]) {
    assert.match(page, new RegExp(text));
  }
  for (const text of ["Welcome back", "Sign in to calendar", "Protected 12-hour staff session"]) {
    assert.match(form, new RegExp(text));
  }
  for (const selector of [".login-window", ".login-overview", ".login-entry", ".login-location"]) {
    assert.ok(css.includes(selector), selector);
  }
});
