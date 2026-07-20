import { type NextRequest, NextResponse } from "next/server";
import { withAuthenticatedUser } from "@/lib/auth";
import { createSetPasswordToken, getUserById } from "@/lib/db/queries";

/**
 * Mint a single-use set-password / reset link for a user. Serves both new-user
 * onboarding (password_hash still NULL) and password reset (existing user).
 * The raw token is returned exactly once — it is never stored in plaintext —
 * and handed to the user out of band. Returns both the raw token and a
 * fully-formed URL built from the request origin for convenience.
 */
export const POST = withAuthenticatedUser(async (req: NextRequest, auth, ctx) => {
  const { id } = await ctx.params;

  const user = getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { rawToken, expiresAt } = createSetPasswordToken(id, auth.userId);

  const origin = req.nextUrl.origin;
  const url = `${origin}/set-password?token=${encodeURIComponent(rawToken)}`;

  return NextResponse.json({
    token: rawToken,
    url,
    expiresAt,
    user: { id: user.id, email: user.email },
  });
});
