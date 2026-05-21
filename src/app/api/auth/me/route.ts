import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getUserById, getAgentById } from "@/lib/db/queries";

export const GET = withAuth(async (req, auth) => {
  if (auth.type === "user") {
    const user = getUserById(auth.userId);
    return NextResponse.json({ type: "user", user });
  }

  const agent = getAgentById(auth.agentId);
  return NextResponse.json({ type: "agent", agent });
});
