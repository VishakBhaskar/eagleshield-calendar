import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDatabase, type Database } from "./client";
import type {
  Appointment,
  CapacityBlock,
  Lane,
  Rep,
  Territory,
  TerritoryId,
} from "@/lib/types";

export interface RuntimeEnvironment {
  CAL_MODE?: string;
  CAL_API_ROOT?: string;
  CAL_SAC_API_KEY?: string;
  CAL_SAC_EVENT_TYPE_ID?: string;
  CAL_SAC_WEBHOOK_SECRET?: string;
  CAL_EB_API_KEY?: string;
  CAL_EB_EVENT_TYPE_ID?: string;
  CAL_EB_WEBHOOK_SECRET?: string;
  CAL_HOLD_EMAIL?: string;
  CRON_SECRET?: string;
  VOICE_AGENT_SECRET?: string;
  MASTER_ADMIN_EMAIL?: string;
  MASTER_ADMIN_PASSWORD?: string;
  MASTER_ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  APP_URL?: string;
  ALLOW_TEST_WEBHOOKS?: string;
}

let schemaReady: Promise<Database> | null = null;

export function getRuntimeEnvironment(): RuntimeEnvironment {
  const injected = (globalThis as typeof globalThis & {
    __EAGLE_RUNTIME_ENV__?: RuntimeEnvironment;
  }).__EAGLE_RUNTIME_ENV__;
  return injected ?? (process.env as RuntimeEnvironment);
}

export async function ensureDatabase(database = getDatabase()) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const schema = await readFile(join(process.cwd(), "db", "schema.sql"), "utf8");
      const statements = schema
        .split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await database.prepare(statement).run();
      return database;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

type RawRep = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  initials: string;
  role: "master_admin" | "manager" | "staff" | null;
  sacramento_eligible: number;
  east_bay_eligible: number;
  active: number;
};

type RawLane = {
  id: string;
  territory_id: TerritoryId;
  label: string;
  ordinal: number;
  active: number;
};

type RawAppointment = {
  id: string;
  cal_uid: string | null;
  cal_seat_uid: string | null;
  confirmation: string;
  customer_name: string;
  customer_email: string;
  phone: string;
  address: string;
  zip: string;
  territory_id: TerritoryId;
  rep_id: string | null;
  lane_id: string;
  date: string;
  slot: string;
  start_at: Date | string;
  end_at: Date | string;
  status: Appointment["status"];
  cal_status: string;
  source: string;
  sync_state: string;
  correlation_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type RawBlock = {
  id: string;
  rule_id: string;
  territory_id: TerritoryId;
  lane_id: string;
  date: string;
  slot: string;
  reason: string;
  cal_uid: string | null;
  cal_seat_uid: string | null;
  status: string;
  sync_state: string;
  error_message: string | null;
  from_date: string;
  to_date: string;
};

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : undefined;

export const mapRep = (row: RawRep): Rep => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  initials: row.initials,
  role: row.role ?? "staff",
  sacramentoEligible: Boolean(row.sacramento_eligible),
  eastBayEligible: Boolean(row.east_bay_eligible),
  active: Boolean(row.active),
});

export const mapLane = (row: RawLane): Lane => ({
  id: row.id,
  territoryId: row.territory_id,
  label: row.label,
  ordinal: Number(row.ordinal),
  active: Boolean(row.active),
});

export const mapAppointment = (row: RawAppointment): Appointment => ({
  id: row.id,
  calUid: row.cal_uid,
  calSeatUid: row.cal_seat_uid,
  confirmation: row.confirmation,
  customerName: row.customer_name,
  customerEmail: row.customer_email,
  phone: row.phone,
  address: row.address,
  zip: row.zip,
  territoryId: row.territory_id,
  repId: row.rep_id ?? "",
  laneId: row.lane_id,
  date: row.date,
  slot: row.slot,
  startAt: iso(row.start_at)!,
  endAt: iso(row.end_at)!,
  status: row.status,
  calStatus: row.cal_status,
  source: row.source,
  syncState: row.sync_state,
  correlationId: row.correlation_id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const mapBlock = (row: RawBlock): CapacityBlock => ({
  id: row.id,
  ruleId: row.rule_id,
  territoryId: row.territory_id,
  laneId: row.lane_id,
  date: row.date,
  slot: row.slot,
  recurrence: "once",
  fromDate: row.from_date,
  toDate: row.to_date,
  reason: row.reason,
  calUid: row.cal_uid,
  calSeatUid: row.cal_seat_uid,
  status: row.status,
  syncState: row.sync_state,
  errorMessage: row.error_message,
});

export async function readSnapshot(from: string, to: string) {
  const db = await ensureDatabase();
  const recentCancellationCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [territoryResult, repResult, laneResult, appointmentResult, blockResult, settingsResult] =
    await db.batch([
      db.prepare("SELECT * FROM territories WHERE active=1 ORDER BY id DESC"),
      db.prepare(
        `SELECT r.*,u.role FROM reps r LEFT JOIN users u ON u.id=r.user_id
         ORDER BY r.active DESC,r.name`,
      ),
      db.prepare("SELECT * FROM lanes WHERE active=1 ORDER BY territory_id DESC,ordinal"),
      db
        .prepare(
          `SELECT * FROM appointments
           WHERE date BETWEEN ? AND ?
              OR (status='Cancelled' AND updated_at >= ?)
           ORDER BY date,slot,created_at`,
        )
        .bind(from, to, recentCancellationCutoff),
      db
        .prepare(
          `SELECT b.*,r.from_date,r.to_date FROM capacity_blocks b
           JOIN capacity_block_rules r ON r.id=b.rule_id
           WHERE b.status IN ('active','cancel_pending') AND b.date BETWEEN ? AND ?
           ORDER BY b.date,b.slot,b.lane_id`,
        )
        .bind(from, to),
      db.prepare("SELECT key,value FROM settings"),
    ]);
  const settings = Object.fromEntries(
    (settingsResult.results as Array<{ key: string; value: string }>).map((row) => [
      row.key,
      row.value,
    ]),
  );
  return {
    territories: (territoryResult.results as Array<{
      id: TerritoryId;
      name: string;
      short_name: string;
      color: string;
    }>).map<Territory>((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      color: row.color,
    })),
    reps: (repResult.results as RawRep[]).map(mapRep),
    lanes: (laneResult.results as RawLane[]).map(mapLane),
    appointments: (appointmentResult.results as RawAppointment[]).map(mapAppointment),
    blocks: (blockResult.results as RawBlock[]).map(mapBlock),
    settings: {
      timeZone: settings.time_zone ?? "America/Los_Angeles",
      cutoffOn: settings.cutoff_on !== "false",
      cutoffHour: Number(settings.cutoff_hour ?? 15),
      cutoffDays: Number(settings.cutoff_days ?? 1),
      appointmentDuration: Number(settings.appointment_duration ?? 120),
      slots: JSON.parse(settings.slots ?? '["10:00","13:00","16:00"]') as string[],
    },
  };
}

export async function writeAudit(input: {
  actorId: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  detail?: unknown;
  correlationId: string;
}) {
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO audit_log
       (id,actor_id,actor_email,action,entity_type,entity_id,detail_json,correlation_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorId,
      input.actorEmail,
      input.action,
      input.entityType,
      input.entityId,
      JSON.stringify(input.detail ?? {}),
      input.correlationId,
    )
    .run();
}

export async function getIdempotentResponse(key: string) {
  const db = await ensureDatabase();
  const row = await db
    .prepare("SELECT state,response_json FROM idempotency_keys WHERE key=?")
    .bind(key)
    .first<{ state: string; response_json: string | null }>();
  return row?.response_json ? (JSON.parse(row.response_json) as unknown) : null;
}

export async function beginIdempotentOperation(key: string, operation: string) {
  const db = await ensureDatabase();
  const result = await db
    .prepare(
      `INSERT INTO idempotency_keys (key,operation,state)
       VALUES (?,?,'processing') ON CONFLICT (key) DO NOTHING`,
    )
    .bind(key, operation)
    .run();
  return result.meta.changes > 0;
}

export async function finishIdempotentOperation(key: string, response: unknown) {
  const db = await ensureDatabase();
  await db
    .prepare(
      `UPDATE idempotency_keys SET state='complete',response_json=?,updated_at=CURRENT_TIMESTAMP
       WHERE key=?`,
    )
    .bind(JSON.stringify(response), key)
    .run();
}

export async function failIdempotentOperation(key: string) {
  const db = await ensureDatabase();
  await db
    .prepare("DELETE FROM idempotency_keys WHERE key=? AND state='processing'")
    .bind(key)
    .run();
}

export async function getAppointment(id: string) {
  const db = await ensureDatabase();
  const row = await db
    .prepare("SELECT * FROM appointments WHERE id=? OR cal_uid=? ORDER BY created_at LIMIT 1")
    .bind(id, id)
    .first<RawAppointment>();
  return row ? mapAppointment(row) : null;
}

export function eventTypeIdFor(territoryId: TerritoryId) {
  const env = getRuntimeEnvironment();
  return territoryId === "SAC" ? env.CAL_SAC_EVENT_TYPE_ID : env.CAL_EB_EVENT_TYPE_ID;
}

export function apiKeyFor(territoryId: TerritoryId) {
  const env = getRuntimeEnvironment();
  return territoryId === "SAC" ? env.CAL_SAC_API_KEY : env.CAL_EB_API_KEY;
}

export function webhookSecretFor(territoryId: TerritoryId) {
  const env = getRuntimeEnvironment();
  return territoryId === "SAC" ? env.CAL_SAC_WEBHOOK_SECRET : env.CAL_EB_WEBHOOK_SECRET;
}

export function territoryForEventType(eventTypeId: string | number | undefined) {
  const value = String(eventTypeId ?? "");
  if (value && value === String(eventTypeIdFor("SAC") ?? "")) return "SAC" as const;
  if (value && value === String(eventTypeIdFor("EB") ?? "")) return "EB" as const;
  return null;
}
