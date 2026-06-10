import { NextResponse } from "next/server";
import { withOrgAuth } from "@/lib/auth";
import { stop as stopProcess } from "@/lib/captain/process-manager";
import {
  deleteConversation,
  getConversation,
  listMessages,
  listToolEventsByMessage,
  updateConversation,
} from "@/lib/db/captain";

export const GET = withOrgAuth(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const messages = listMessages(id).map((msg) => {
      if (msg.role === "assistant") {
        const toolEvents = listToolEventsByMessage(msg.id);
        return { ...msg, toolEvents };
      }
      return { ...msg, toolEvents: [] };
    });
    return NextResponse.json({ ...conversation, messages });
  },
  { role: "viewer" },
);

export const PUT = withOrgAuth(
  async (req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await req.json();
    if (body.title) {
      updateConversation(id, { title: body.title });
    }
    return NextResponse.json(getConversation(id, auth.orgId));
  },
  { role: "editor" },
);

export const DELETE = withOrgAuth(
  async (_req, auth, { params }) => {
    const { id } = await params;
    const conversation = getConversation(id, auth.orgId);
    if (!conversation || conversation.user_id !== auth.userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    stopProcess(id);
    deleteConversation(id);
    return NextResponse.json({ ok: true });
  },
  { role: "editor" },
);
