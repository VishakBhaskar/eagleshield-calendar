# Eagle Shield Calendar

Eagle Shield's private appointment operations app for Sacramento and East Bay. The supplied prototype remains the visual contract; the implementation adds authenticated access, Postgres persistence, Cal.com synchronization, bulk capacity controls, and Railway deployment without replacing the original calendar design.

## The Cal.com model: two calendars total

Use exactly **two standalone Cal.com accounts/calendars**, one per location. Do not create a Cal team and do not add Eagle Shield staff to Cal.com.

| Location | Cal.com setup | Capacity |
| --- | --- | --- |
| Sacramento | One standalone account and one seated event type | `seatsPerTimeSlot = 2` |
| East Bay | One standalone account and one normal event type | 1 appointment per slot |

Use separate accounts, not merely two event types owned by the same host. Otherwise the host's busy calendar can make an East Bay booking close Sacramento (or the reverse). Staff, managers, eligibility, and appointment assignments exist only in this app.

Every real booking and every capacity hold is written to the appropriate location's event type. A Sacramento booking stores both Cal.com's shared booking UID and the attendee's `seatUid`; cancelling without a seat UID is deliberately refused so the other customer in that seated booking cannot be cancelled by accident.

### How partial and bulk blocks work

Cal.com has no reliable date-specific control that changes a seated event from two seats to one for only one hour while leaving later dates at two. The app therefore consumes capacity with ordinary, identifiable Cal.com hold bookings:

- Block one Sacramento seat at Tuesday 1 PM: create one hold attendee in the Sacramento seated booking. One customer seat remains.
- Block both Sacramento seats: create two hold attendees. The slot becomes unavailable.
- Block East Bay: create one hold booking. The slot becomes unavailable.
- Remove a block: cancel only the hold's stored `seatUid`. Customer seats are untouched.

The Bulk block times dialog accepts one or both locations, a start/end date, selected weekdays, one or more appointment times, and either one or both Sacramento seats. It preflights all requested capacity before writing anything, limits a request to 1,000 hold rows, uses idempotency keys, syncs four holds at a time, and records failed/deferred work for reconciliation. It never changes the location's future default capacity.

## What is implemented

- Preserved week, month, scheduling, and appointment-log UI.
- Sacramento capacity 2 and East Bay capacity 1, independent of staff assignment.
- Single-time partial blocks and multi-date, multi-weekday, multi-location bulk blocks.
- Booking, assignment/unassignment, rescheduling, cancellation, search, and after-hours cutoff.
- Master-admin login from environment variables; master admins can create and deactivate app users with staff, manager, or master-admin access.
- Argon2id password hashes, server-side sessions, secure/HTTP-only cookies, login throttling, role checks, and audit records.
- Live Cal slot checks and writes, three-attempt retry for transient errors, idempotency protection, and compensating rollback.
- HMAC-verified, deduplicated Cal webhooks so direct voice-agent bookings appear in the app.
- A bearer-protected app booking endpoint for voice agents that need a single reliable gateway.
- A repair endpoint that reconciles Cal bookings and retries pending capacity holds/cancellations.
- PostgreSQL constraints that prevent overbooking a location lane or assigning one rep to overlapping appointments.
- Railway Docker build, automatic schema migration, deployment health check, and embedded five-minute reconciliation.

## Cal.com setup

1. Create or use a standalone Cal.com account for Sacramento and another for East Bay. An external Google/Outlook destination calendar is optional; Cal.com itself remains the booking source of truth. If you connect external calendars later, keep each account isolated to its own location.
2. Set both accounts to `America/Los_Angeles` and configure the appointment schedule. The app's current slot starts are 10:00 AM, 1:00 PM, and 4:00 PM with 120-minute duration.
3. In Sacramento, create an individual event type with seats enabled and exactly two seats per time slot. Enable showing attendees so the API and webhook payloads consistently expose seat identifiers.
4. In East Bay, create a normal individual event type. Do not enable multiple seats.
5. Create an API key in each Cal account and copy each event type's numeric ID.
6. In each account, create a webhook pointing to `https://YOUR_DOMAIN/api/webhooks/cal`. Give the two webhooks different long secrets. Enable at least `BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_CONFIRMED`, and `BOOKING_REJECTED`. Do not use a custom payload template.
7. Put the two keys, IDs, and webhook secrets into the Railway variables shown below. Run `railway run -s eagleshield-calendar npm.cmd run cal:configure` to idempotently configure and verify both event types, in-person booking fields, capacities, and signed webhooks. After deployment, sign in as the master admin and issue `POST /api/setup/cal` with the session cookie for an application-level validation.

`CAL_HOLD_EMAIL` should be a real mailbox or accepted alias you control. The app creates unique `+capacity-...` addresses from it so each hold gets a distinct seated attendee. A mailbox rule can archive Cal notifications sent to that alias.

## Railway deployment

1. Create a Railway project and add a PostgreSQL service.
2. Create the app service from this repository. Railway detects the root `Dockerfile`; `railway.json` configures `/api/health` as the deploy health check.
3. Give the app a public domain, then paste the following in its Variables raw editor. If the database service is not named `Postgres`, change that reference name.

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=at_least_32_random_bytes
MASTER_ADMIN_EMAIL=admin@eagleshield.com
MASTER_ADMIN_PASSWORD=a_long_unique_initial_password
APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}

CAL_MODE=live
CAL_SAC_API_KEY=cal_sacramento_key
CAL_SAC_EVENT_TYPE_ID=12345
CAL_SAC_WEBHOOK_SECRET=a_long_sacramento_webhook_secret
CAL_EB_API_KEY=cal_east_bay_key
CAL_EB_EVENT_TYPE_ID=67890
CAL_EB_WEBHOOK_SECRET=a_different_long_east_bay_webhook_secret
CAL_HOLD_EMAIL=calendar@eagleshield.com

CRON_SECRET=a_long_reconciliation_secret
VOICE_AGENT_SECRET=a_different_long_voice_gateway_secret
RECONCILE_INTERVAL_MS=300000
```

The start command runs `db/schema.sql` idempotently before starting the compiled Next.js server. Keep the app at one replica until a shared rate limiter/lock service is added; Postgres still enforces booking capacity if two requests race.

Reconciliation runs inside the same Railway app service: it waits for the server, repairs missed webhooks and pending Cal writes immediately after startup, then repeats every five minutes. `CRON_SECRET` protects the repair endpoint and the Postgres lock prevents overlapping runs. Do not create a second Railway cron service.

After the first deploy:

1. Open the app and sign in with `MASTER_ADMIN_EMAIL` and `MASTER_ADMIN_PASSWORD`.
2. Validate the Cal connection with `POST /api/setup/cal` while signed in.
3. Use the plus button beside Reps to add each manager/staff user and give them an initial password of at least 12 characters.
4. Create a one-seat Sacramento test block, confirm one booking still succeeds and a second is rejected, then remove the block.
5. Create a test booking directly through each public Cal event page and verify it appears in the app within 30 seconds (normally immediately through the webhook).
6. Confirm `/api/health` reports `status: "ok"`, `database: "ok"`, no missing secrets, zero failed webhooks/unsynced records, and a recent non-null `lastReconcileAt`.
7. Confirm Railway logs contain `Embedded reconciliation completed.` and `Embedded reconciliation scheduled every 300000ms.`.

## Voice agent

Two supported paths are intentionally available:

1. Preferred: the voice agent calls `POST /api/appointments` with `Authorization: Bearer $VOICE_AGENT_SECRET` and a unique `Idempotency-Key`. This applies app cutoff and capacity rules before booking Cal.
2. Existing Cal integration: the voice agent books the appropriate public location event type directly. The signed webhook imports it into this app unassigned, where the manager assigns a rep.

Example gateway payload:

```json
{
  "customerName": "Jane Customer",
  "customerEmail": "jane@example.com",
  "phone": "+19165550123",
  "address": "123 Main Street",
  "zip": "95814",
  "territoryId": "SAC",
  "date": "2026-08-17",
  "slot": "10:00"
}
```

## Local development and verification

Node.js 22.13 or newer is required. Copy `.dev.vars.example` to `.env.local`. Use `CAL_MODE=mock` for local UI work without touching Cal; omit `DATABASE_URL` only when intentionally using the in-memory development database.

```bash
npm install
npm run dev
npm test
```

`npm test` runs TypeScript checking, unit/contract tests, a production build, and an API end-to-end test against a realistic fake Cal server. The E2E path covers authentication and authorization, user creation, two-location configuration validation, bulk/idempotent holds, partial Sacramento capacity, full capacity rejection, rep conflicts, the voice gateway, webhook import/deduplication, seat-safe cancellation, block removal, reconciliation, health, and logout.

## Operating rules

- Never expose either Cal API key, webhook secret, database URL, session secret, or voice secret to browser code.
- Seal production secrets in Railway after setup.
- Keep both Cal event types dedicated to this business workflow; do not let unrelated event types share their destination calendars.
- Monitor the JSON from `/api/health` externally after deployment. Railway's deploy health check only proves startup; it is not continuous monitoring.
- Keep embedded reconciliation enabled every five minutes even when webhooks are healthy.
- Back up PostgreSQL and periodically test restoring it. Cal is the booking/capacity source of truth; Postgres is the operational mirror, assignment store, user store, and audit trail.
- Before going live, repeat the seat/cancellation test above in a staging pair of Cal accounts using the actual plan and settings that production will use.

Primary references: [Cal.com seated event types](https://cal.com/docs/api-reference/v2/event-types/create-an-event-type), [available seated slots](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type), [seat-specific cancellation](https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking), [webhook signatures](https://cal.com/docs/developing/guides/automation/webhooks), [Railway PostgreSQL](https://docs.railway.com/databases/postgresql), and [Railway variables](https://docs.railway.com/variables).
