import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const territories = pgTable("territories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  color: text("color").notNull(),
  active: integer("active").notNull().default(1),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("staff"),
    active: integer("active").notNull().default(1),
    mustChangePassword: integer("must_change_password").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_users_email").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_sessions_token_hash").on(table.tokenHash)],
);

export const reps = pgTable("reps", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  initials: text("initials").notNull(),
  sacramentoEligible: integer("sacramento_eligible").notNull().default(1),
  eastBayEligible: integer("east_bay_eligible").notNull().default(1),
  active: integer("active").notNull().default(1),
});

export const lanes = pgTable("lanes", {
  id: text("id").primaryKey(),
  territoryId: text("territory_id").notNull().references(() => territories.id),
  label: text("label").notNull(),
  ordinal: integer("ordinal").notNull(),
  active: integer("active").notNull().default(1),
});

export const appointments = pgTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    calUid: text("cal_uid"),
    calSeatUid: text("cal_seat_uid"),
    externalKey: text("external_key"),
    confirmation: text("confirmation").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    zip: text("zip").notNull().default(""),
    territoryId: text("territory_id").notNull().references(() => territories.id),
    repId: text("rep_id").references(() => reps.id, { onDelete: "set null" }),
    laneId: text("lane_id").notNull().references(() => lanes.id),
    date: text("date").notNull(),
    slot: text("slot").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("Scheduled"),
    calStatus: text("cal_status").notNull().default("accepted"),
    source: text("source").notNull().default("calendar-ui"),
    syncState: text("sync_state").notNull().default("synced"),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [
    uniqueIndex("idx_appointments_confirmation").on(table.confirmation),
    uniqueIndex("idx_appointments_external_key").on(table.externalKey),
    index("idx_appointments_date_slot").on(table.date, table.slot),
  ],
);

export const capacityBlockRules = pgTable("capacity_block_rules", {
  id: text("id").primaryKey(),
  reason: text("reason").notNull(),
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  weekdaysJson: text("weekdays_json").notNull(),
  slotsJson: text("slots_json").notNull(),
  territoriesJson: text("territories_json").notNull(),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").notNull(),
});

export const capacityBlocks = pgTable(
  "capacity_blocks",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull().references(() => capacityBlockRules.id, { onDelete: "cascade" }),
    territoryId: text("territory_id").notNull().references(() => territories.id),
    laneId: text("lane_id").notNull().references(() => lanes.id),
    date: text("date").notNull(),
    slot: text("slot").notNull(),
    reason: text("reason").notNull(),
    calUid: text("cal_uid"),
    calSeatUid: text("cal_seat_uid"),
    status: text("status").notNull().default("active"),
    syncState: text("sync_state").notNull().default("pending"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("idx_blocks_territory_date").on(table.territoryId, table.date),
    index("idx_blocks_rule").on(table.ruleId),
  ],
);
