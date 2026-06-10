import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { createConversation, listConversations } from "@/lib/db/captain";
import { getSetting } from "@/lib/db/settings";

export const GET = withOrgAuth(
  async (_req, auth) => {
    const conversations = listConversations(auth.orgId, auth.userId);
    return NextResponse.json(conversations);
  },
  { role: "viewer" },
);

export const POST = withOrgAuth(
  async (req, auth) => {
    const body = await req.json();
    const title = body.title || "New conversation";

    const cli = getSetting("captain_cli") || "claude";
    const model = getSetting("captain_model") || null;
    const thinking = getSetting("captain_thinking") || null;
    const cwd = getSetting("captain_cwd") || null;

    const conversation = createConversation(
      auth.orgId,
      title,
      cli,
      model,
      thinking,
      cwd,
      auth.userId,
    );
    return NextResponse.json(conversation, { status: 201 });
  },
  { role: "editor" },
);
