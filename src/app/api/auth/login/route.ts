import { NextRequest, NextResponse } from "next/server";
import { authenticateUser, createSession, sessionTtlSeconds } from "@/lib/db/queries";
import { sessionCookieOptions } from "@/lib/auth";
import { clientIp, loginLimiter } from "@/lib/rate-limit";

// Intentionally public (no auth wrapper) — brute force is throttled per
// email+IP instead: 5 failed attempts per 15 minutes, cleared on success.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "email and password are required" },
        { status: 400 }
      );
    }

    const limitKey = `${String(email).trim().toLowerCase()}:${clientIp(req)}`;
    if (loginLimiter.isLimited(limitKey)) {
      return NextResponse.json(
        { error: "Too many failed login attempts. Try again later." },
        { status: 429 }
      );
    }

    const user = authenticateUser(email, password);
    if (!user) {
      loginLimiter.record(limitKey);
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    loginLimiter.reset(limitKey);
    const sessionId = createSession(user.id);

    const response = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
    });

    response.cookies.set("harbour_session", sessionId, sessionCookieOptions(req, sessionTtlSeconds()));

    return response;
  } catch {
    return NextResponse.json(
      { error: "Failed to login" },
      { status: 500 }
    );
  }
}
