import { type NextRequest, NextResponse } from "next/server";
import { deleteSession } from "@/lib/db/queries";

export async function POST(req: NextRequest) {
  try {
    const sessionId = req.cookies.get("harbour_session")?.value;
    if (sessionId) {
      deleteSession(sessionId);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("harbour_session", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch {
    return NextResponse.json({ error: "Failed to logout" }, { status: 500 });
  }
}
