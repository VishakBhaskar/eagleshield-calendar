import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { ensureDatabase, getRuntimeEnvironment } from "@/db/runtime";
import type { UserRole } from "@/lib/types";

export const SESSION_COOKIE = "eagle_session";
const SESSION_SECONDS = 60 * 60 * 12;

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: UserRole | "voice_agent";
}

type UserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  active: number;
  must_change_password: number;
};

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const pair of cookie.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function sessionHash(token: string) {
  const secret = getRuntimeEnvironment().SESSION_SECRET ?? "local-session-secret";
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export async function hashPassword(password: string) {
  return hash(password, {
    memoryCost: process.env.NODE_ENV === "test" ? 4096 : 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function bootstrapMasterAdmin() {
  const db = await ensureDatabase();
  const env = getRuntimeEnvironment();
  const email = (env.MASTER_ADMIN_EMAIL ?? (process.env.NODE_ENV === "production" ? "" : "admin@eagleshield.test"))
    .trim()
    .toLowerCase();
  if (!email) throw new Error("MASTER_ADMIN_EMAIL is required.");
  const existing = await db
    .prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1")
    .bind(email)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const configuredHash = env.MASTER_ADMIN_PASSWORD_HASH?.trim();
  const plainPassword =
    env.MASTER_ADMIN_PASSWORD ??
    (process.env.NODE_ENV === "production" ? "" : "EagleShieldLocal!2026");
  if (!configuredHash && !plainPassword) {
    throw new Error("MASTER_ADMIN_PASSWORD_HASH or MASTER_ADMIN_PASSWORD is required.");
  }
  const passwordHash = configuredHash || (await hashPassword(plainPassword));
  const name = email
    .split("@")[0]
    .split(/[._-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Master Admin";
  const id = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users
         (id,name,email,password_hash,role,active,must_change_password)
         VALUES (?,?,?,?,'master_admin',1,0)`,
      )
      .bind(id, name, email, passwordHash),
    db
      .prepare(
        `INSERT INTO reps
         (id,user_id,name,email,initials,sacramento_eligible,east_bay_eligible,active)
         VALUES (?,?,?,?,?,1,1,1)`,
      )
      .bind(id, id, name, email, initials(name)),
  ]);
  return id;
}

export async function findUserForLogin(email: string) {
  await bootstrapMasterAdmin();
  const db = await ensureDatabase();
  return db
    .prepare("SELECT * FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1")
    .bind(email.trim())
    .first<UserRow>();
}

export async function tooManyLoginAttempts(email: string, ipAddress: string) {
  const db = await ensureDatabase();
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS failures FROM login_attempts
       WHERE LOWER(email)=LOWER(?) AND ip_address=? AND succeeded=0
         AND attempted_at > ?`,
    )
    .bind(email, ipAddress, since)
    .first<{ failures: number }>();
  return Number(row?.failures ?? 0) >= 10;
}

export async function recordLoginAttempt(email: string, ipAddress: string, succeeded: boolean) {
  const db = await ensureDatabase();
  await db
    .prepare(
      `INSERT INTO login_attempts (id,email,ip_address,succeeded)
       VALUES (?,?,?,?)`,
    )
    .bind(crypto.randomUUID(), email.toLowerCase(), ipAddress, succeeded ? 1 : 0)
    .run();
}

export async function createSession(userId: string) {
  const db = await ensureDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO sessions (id,user_id,token_hash,expires_at)
       VALUES (?,?,?,?)`,
    )
    .bind(crypto.randomUUID(), userId, sessionHash(token), expiresAt)
    .run();
  return token;
}

export function sessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function expiredSessionCookie() {
  const secure = process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function deleteSession(token: string) {
  if (!token) return;
  const db = await ensureDatabase();
  await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(sessionHash(token)).run();
}

export async function actorForSessionToken(token: string): Promise<Actor | null> {
  if (!token) return null;
  const db = await ensureDatabase();
  const row = await db
    .prepare(
      `SELECT u.id,u.email,u.name,u.role FROM sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
       LIMIT 1`,
    )
    .bind(sessionHash(token), new Date().toISOString())
    .first<{ id: string; email: string; name: string; role: UserRole }>();
  return row ? { ...row } : null;
}

export async function getActor(request: Request): Promise<Actor | null> {
  const voiceSecret = getRuntimeEnvironment().VOICE_AGENT_SECRET;
  if (voiceSecret && request.headers.get("authorization") === `Bearer ${voiceSecret}`) {
    return {
      id: "voice-agent",
      email: "voice-agent@eagleshield.com",
      name: "Voice Agent",
      role: "voice_agent",
    };
  }
  return actorForSessionToken(cookieValue(request, SESSION_COOKIE));
}

export async function requireActor(
  request: Request,
  roles?: Array<UserRole | "voice_agent">,
) {
  const actor = await getActor(request);
  const permitted = !roles || (actor !== null && roles.includes(actor.role));
  if (actor === null) {
    return {
      actor: null,
      response: Response.json({ error: "Authentication required" }, { status: 401 }),
    } as const;
  }
  if (!permitted) {
    return {
      actor: null,
      response: Response.json({ error: "You do not have permission for this action" }, { status: 403 }),
    } as const;
  }
  return { actor, response: null } as const;
}

export function requestIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function sessionTokenFromRequest(request: Request) {
  return cookieValue(request, SESSION_COOKIE);
}
