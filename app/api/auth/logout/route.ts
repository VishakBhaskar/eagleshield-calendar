import {
  deleteSession,
  expiredSessionCookie,
  sessionTokenFromRequest,
} from "@/lib/auth";

export async function POST(request: Request) {
  await deleteSession(sessionTokenFromRequest(request));
  return Response.json(
    { signedOut: true },
    { headers: { "Set-Cookie": expiredSessionCookie(), "Cache-Control": "no-store" } },
  );
}
