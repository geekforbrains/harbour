import { NextRequest, NextResponse } from "next/server";
import { consumeSetPasswordToken, createSession } from "@/lib/db/queries";
import { sessionCookieOptions } from "@/lib/auth";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Public endpoint to redeem a set-password / reset token. No auth wrapper: the
 * single-use token IS the credential. On success the token is consumed, the
 * user's password is set, and a session cookie is issued so the user lands
 * signed in. Token validation and the password write happen atomically inside
 * consumeSetPasswordToken.
 */
export async function POST(req: NextRequest) {
  let body: { token?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const result = consumeSetPasswordToken(token, password);
  if (!result.ok) {
    // Don't distinguish reasons to the client beyond invalid/expired — all map
    // to "this link can't be used."
    return NextResponse.json(
      { error: "This link is invalid or has expired." },
      { status: 400 }
    );
  }

  const sessionId = createSession(result.userId);
  const response = NextResponse.json({ ok: true });
  response.cookies.set("harbour_session", sessionId, sessionCookieOptions(req));
  return response;
}
