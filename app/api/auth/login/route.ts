import {
  createSession,
  findUserForLogin,
  recordLoginAttempt,
  requestIp,
  sessionCookie,
  tooManyLoginAttempts,
  verifyPassword,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;
  const email = payload?.email?.trim().toLowerCase() ?? "";
  const password = payload?.password ?? "";
  if (!email || !password) {
    return Response.json({ error: "Email and password are required" }, { status: 400 });
  }
  const ip = requestIp(request);
  if (await tooManyLoginAttempts(email, ip)) {
    return Response.json(
      { error: "Too many login attempts. Try again in 15 minutes." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }
  const user = await findUserForLogin(email);
  const valid = Boolean(user?.active) && Boolean(user && (await verifyPassword(user.password_hash, password)));
  await recordLoginAttempt(email, ip, valid);
  if (!valid || !user) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }
  const token = await createSession(user.id);
  return Response.json(
    { user: { id: user.id, name: user.name, email: user.email, role: user.role } },
    { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
  );
}
