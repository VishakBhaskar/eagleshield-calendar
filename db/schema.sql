CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS territories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  color TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('master_admin', 'manager', 'staff')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
  ON login_attempts(email, ip_address, attempted_at);

CREATE TABLE IF NOT EXISTS reps (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  initials TEXT NOT NULL,
  sacramento_eligible INTEGER NOT NULL DEFAULT 1 CHECK (sacramento_eligible IN (0, 1)),
  east_bay_eligible INTEGER NOT NULL DEFAULT 1 CHECK (east_bay_eligible IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reps_email_lower ON reps (LOWER(email));

CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL REFERENCES territories(id),
  label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (territory_id, ordinal)
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  cal_uid TEXT,
  cal_seat_uid TEXT,
  external_key TEXT,
  confirmation TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  territory_id TEXT NOT NULL REFERENCES territories(id),
  rep_id TEXT REFERENCES reps(id) ON DELETE SET NULL,
  lane_id TEXT NOT NULL REFERENCES lanes(id),
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  cal_status TEXT NOT NULL DEFAULT 'accepted',
  source TEXT NOT NULL DEFAULT 'calendar-ui',
  sync_state TEXT NOT NULL DEFAULT 'synced',
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_confirmation ON appointments(confirmation);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_correlation ON appointments(correlation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_external_key ON appointments(external_key) WHERE external_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_cal_uid ON appointments(cal_uid);
CREATE INDEX IF NOT EXISTS idx_appointments_date_slot ON appointments(date, slot);
CREATE INDEX IF NOT EXISTS idx_appointments_territory_date ON appointments(territory_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_active_rep_time
  ON appointments(rep_id, start_at) WHERE status != 'Cancelled' AND rep_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_active_lane_time
  ON appointments(lane_id, start_at) WHERE status != 'Cancelled';

CREATE TABLE IF NOT EXISTS capacity_block_rules (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'Capacity hold',
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  weekdays_json TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  territories_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS capacity_blocks (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES capacity_block_rules(id) ON DELETE CASCADE,
  territory_id TEXT NOT NULL REFERENCES territories(id),
  lane_id TEXT NOT NULL REFERENCES lanes(id),
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Capacity hold',
  cal_uid TEXT,
  cal_seat_uid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  sync_state TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blocks_territory_date ON capacity_blocks(territory_id, date);
CREATE INDEX IF NOT EXISTS idx_blocks_rule ON capacity_blocks(rule_id);
CREATE INDEX IF NOT EXISTS idx_blocks_sync_state ON capacity_blocks(sync_state, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_active_lane_time
  ON capacity_blocks(lane_id, date, slot) WHERE status IN ('active', 'cancel_pending');

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  trigger TEXT NOT NULL,
  booking_uid TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received',
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_fingerprint ON webhook_events(fingerprint);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

INSERT INTO territories (id, name, short_name, color)
VALUES
  ('SAC', 'Sacramento', 'Sac', '#2e7d32'),
  ('EB', 'East Bay', 'EB', '#d97a00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO lanes (id, territory_id, label, ordinal)
VALUES
  ('sac_1', 'SAC', 'Sacramento Seat 1', 1),
  ('sac_2', 'SAC', 'Sacramento Seat 2', 2),
  ('eb_1', 'EB', 'East Bay Seat 1', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings (key, value)
VALUES
  ('time_zone', 'America/Los_Angeles'),
  ('cutoff_on', 'true'),
  ('cutoff_hour', '15'),
  ('cutoff_days', '1'),
  ('appointment_duration', '120'),
  ('slots', '["10:00","13:00","16:00"]')
ON CONFLICT (key) DO NOTHING;
